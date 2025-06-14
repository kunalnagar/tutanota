import { MailTypeRef } from "../../../common/api/entities/tutanota/TypeRefs.js"
import { DbTransaction } from "../../../common/api/worker/search/DbFacade.js"
import {
	arrayHash,
	asyncFind,
	contains,
	downcast,
	getDayShifted,
	getStartOfDay,
	isEmpty,
	isNotNull,
	isSameTypeRef,
	neverNull,
	ofClass,
	promiseMap,
	promiseMapCompat,
	PromiseMapFn,
	tokenize,
	TypeRef,
	uint8ArrayToBase64,
} from "@tutao/tutanota-utils"
import type {
	Db,
	DecryptedSearchIndexEntry,
	ElementDataDbRow,
	EncryptedSearchIndexEntry,
	EncryptedSearchIndexEntryWithHash,
	KeyToEncryptedIndexEntries,
	KeyToIndexEntries,
	MoreResultsIndexEntry,
	SearchIndexEntry,
	SearchIndexMetaDataDbRow,
	SearchIndexMetadataEntry,
	SearchIndexMetaDataRow,
	SearchRestriction,
	SearchResult,
} from "../../../common/api/worker/search/SearchTypes.js"
import type { TypeInfo } from "../../../common/api/worker/search/IndexUtils.js"
import {
	decryptMetaData,
	decryptSearchIndexEntry,
	encryptIndexKeyBase64,
	getIdFromEncSearchIndexEntry,
	getPerformanceTimestamp,
	markEnd,
	markStart,
	printMeasure,
	typeRefToTypeInfo,
} from "../../../common/api/worker/search/IndexUtils.js"
import { FULL_INDEXED_TIMESTAMP, NOTHING_INDEXED_TIMESTAMP } from "../../../common/api/common/TutanotaConstants.js"
import { compareNewestFirst, elementIdPart, firstBiggerThanSecond, timestampToGeneratedId } from "../../../common/api/common/utils/EntityUtils.js"
import { INITIAL_MAIL_INDEX_INTERVAL_DAYS, MailIndexer } from "./MailIndexer.js"
import { SuggestionFacade } from "./SuggestionFacade.js"
import { AssociationType, Cardinality, ValueType } from "../../../common/api/common/EntityConstants.js"
import { NotAuthorizedError, NotFoundError } from "../../../common/api/common/error/RestError.js"
import { iterateBinaryBlocks } from "../../../common/api/worker/search/SearchIndexEncoding.js"
import type { BrowserData } from "../../../common/misc/ClientConstants.js"
import type { TypeModel } from "../../../common/api/common/EntityTypes.js"
import { EntityClient } from "../../../common/api/common/EntityClient.js"
import { UserFacade } from "../../../common/api/worker/facades/UserFacade.js"
import { ElementDataOS, SearchIndexMetaDataOS, SearchIndexOS, SearchIndexWordsIndex } from "../../../common/api/worker/search/IndexTables.js"
import { ClientTypeModelResolver, TypeModelResolver } from "../../../common/api/common/EntityFunctions"

type RowsToReadForIndexKey = {
	indexKey: string
	rows: Array<SearchIndexMetadataEntry>
}

export class SearchFacade {
	private readonly promiseMapCompat: PromiseMapFn

	constructor(
		private readonly userFacade: UserFacade,
		private readonly db: Db,
		private readonly mailIndexer: MailIndexer,
		private readonly suggestionFacades: SuggestionFacade<any>[],
		browserData: BrowserData,
		private readonly entityClient: EntityClient,
		private readonly typeModelResolver: ClientTypeModelResolver,
	) {
		this.promiseMapCompat = promiseMapCompat(browserData.needsMicrotaskHack)
	}

	/****************************** SEARCH ******************************/

	/**
	 * Invoke an AND-query.
	 * @param query is tokenized. All tokens must be matched by the result (AND-query)
	 * @param minSuggestionCount If minSuggestionCount > 0 regards the last query token as suggestion token and includes suggestion results for that token, but not less than minSuggestionCount
	 * @returns The result ids are sorted by id from newest to oldest
	 */
	search(query: string, restriction: SearchRestriction, minSuggestionCount: number, maxResults?: number): Promise<SearchResult> {
		return this.db.initialized.then(() => {
			let searchTokens = tokenize(query)
			let result: SearchResult = {
				query,
				restriction,
				results: [],
				currentIndexTimestamp: this.getSearchEndTimestamp(restriction),
				lastReadSearchIndexRow: searchTokens.map((token) => [token, null]),
				matchWordOrder: searchTokens.length > 1 && query.startsWith('"') && query.endsWith('"'),
				moreResults: [],
				moreResultsEntries: [],
			}

			if (searchTokens.length > 0) {
				let isFirstWordSearch = searchTokens.length === 1
				let before = getPerformanceTimestamp()

				let suggestionFacade = this.suggestionFacades.find((f) => isSameTypeRef(f.type, restriction.type))

				let searchPromise

				if (minSuggestionCount > 0 && isFirstWordSearch && suggestionFacade) {
					let addSuggestionBefore = getPerformanceTimestamp()
					searchPromise = this.addSuggestions(searchTokens[0], suggestionFacade, minSuggestionCount, result).then(() => {
						if (result.results.length < minSuggestionCount) {
							// there may be fields that are not indexed with suggestions but which we can find with the normal search
							// TODO: let suggestion facade and search facade know which fields are
							// indexed with suggestions, so that we
							// 1) know if we also have to search normally and
							// 2) in which fields we have to search for second word suggestions because now we would also find words of non-suggestion fields as second words
							let searchForTokensAfterSuggestionsBefore = getPerformanceTimestamp()
							return this.startOrContinueSearch(result).then((result) => {
								return result
							})
						}
					})
				} else if (minSuggestionCount > 0 && !isFirstWordSearch && suggestionFacade) {
					let suggestionToken = neverNull(result.lastReadSearchIndexRow.pop())[0]
					searchPromise = this.startOrContinueSearch(result).then(() => {
						// we now filter for the suggestion token manually because searching for suggestions for the last word and reducing the initial search result with them can lead to
						// dozens of searches without any effect when the seach token is found in too many contacts, e.g. in the email address with the ending "de"
						result.results.sort(compareNewestFirst)
						return this.loadAndReduce(restriction, result, suggestionToken, minSuggestionCount)
					})
				} else {
					searchPromise = this.startOrContinueSearch(result, maxResults)
				}

				return searchPromise.then(() => {
					result.results.sort(compareNewestFirst)
					return result
				})
			} else {
				return Promise.resolve(result)
			}
		})
	}

	private async loadAndReduce(restriction: SearchRestriction, result: SearchResult, suggestionToken: string, minSuggestionCount: number): Promise<void> {
		if (result.results.length > 0) {
			const model = await this.typeModelResolver.resolveClientTypeReference(restriction.type)
			// if we want the exact search order we try to find the complete sequence of words in an attribute of the instance.
			// for other cases we only check that an attribute contains a word that starts with suggestion word
			const suggestionQuery = result.matchWordOrder ? normalizeQuery(result.query) : suggestionToken
			const finalResults: IdTuple[] = []

			for (const id of result.results) {
				if (finalResults.length >= minSuggestionCount) {
					break
				} else {
					let entity

					try {
						entity = await this.entityClient.load(restriction.type, id)
					} catch (e) {
						if (e instanceof NotFoundError || e instanceof NotAuthorizedError) {
							continue
						} else {
							throw e
						}
					}

					const found = await this.containsSuggestionToken(entity, model, restriction.attributeIds, suggestionQuery, result.matchWordOrder)

					if (found) {
						finalResults.push(id)
					}
				}
			}

			result.results = finalResults
		} else {
			return Promise.resolve()
		}
	}

	/**
	 * Looks for a word in any of the entities string values or aggregations string values that starts with suggestionToken.
	 * @param attributeIds Only looks in these attribute ids (or all its string values if it is an aggregation attribute id. If null, looks in all string values and aggregations.
	 */
	private containsSuggestionToken(
		entity: Record<string, any>,
		model: TypeModel,
		attributeIds: number[] | null,
		suggestionToken: string,
		matchWordOrder: boolean,
	): Promise<boolean> {
		if (!attributeIds) {
			attributeIds = Object.keys(model.values).map(Number).concat(Object.keys(model.associations).map(Number))
		}

		return asyncFind(attributeIds, async (attributeId) => {
			const modelValue = model.values[attributeId]
			if (modelValue && modelValue.type === ValueType.String && entity[modelValue.name]) {
				const attributeValue = entity[modelValue.name]
				if (matchWordOrder) {
					return Promise.resolve(normalizeQuery(attributeValue).indexOf(suggestionToken) !== -1)
				} else {
					let words = tokenize(attributeValue)
					return Promise.resolve(words.some((w) => w.startsWith(suggestionToken)))
				}
			} else {
				const modelAssociation = model.associations[attributeId]
				if (modelAssociation && modelAssociation.type === AssociationType.Aggregation && entity[modelAssociation.name]) {
					let aggregates = modelAssociation.cardinality === Cardinality.Any ? entity[modelAssociation.name] : [entity[modelAssociation.name]]
					const refModel = await this.typeModelResolver.resolveClientTypeReference(new TypeRef(model.app, modelAssociation.refTypeId))
					return asyncFind(aggregates, (aggregate) => {
						return this.containsSuggestionToken(downcast<Record<string, any>>(aggregate), refModel, null, suggestionToken, matchWordOrder)
					}).then((found) => found != null)
				} else {
					return Promise.resolve(false)
				}
			}
		}).then((found) => found != null)
	}

	private startOrContinueSearch(searchResult: SearchResult, maxResults?: number): Promise<void> {
		const nextScheduledIndexingRun = getStartOfDay(getDayShifted(new Date(this.mailIndexer.currentIndexTimestamp), INITIAL_MAIL_INDEX_INTERVAL_DAYS))
		const theDayAfterTomorrow = getStartOfDay(getDayShifted(new Date(), 1))

		if (
			searchResult.moreResults.length === 0 &&
			nextScheduledIndexingRun.getTime() > theDayAfterTomorrow.getTime() &&
			!this.mailIndexer.isIndexing &&
			isSameTypeRef(searchResult.restriction.type, MailTypeRef)
		) {
			// Extend index and then retry this function
			return this.mailIndexer
				.extendIndexIfNeeded(this.userFacade.getLoggedInUser(), getStartOfDay(getDayShifted(new Date(), -INITIAL_MAIL_INDEX_INTERVAL_DAYS)).getTime())
				.then((_) => this.startOrContinueSearch(searchResult, maxResults))
		}

		markStart("findIndexEntries")

		let moreResultsEntries: Promise<Array<MoreResultsIndexEntry>>

		if (maxResults && searchResult.moreResults.length >= maxResults) {
			moreResultsEntries = Promise.resolve(searchResult.moreResults)
		} else {
			moreResultsEntries = this.findIndexEntries(searchResult, maxResults)
				.then((keyToEncryptedIndexEntries) => {
					markEnd("findIndexEntries")
					markStart("_filterByEncryptedId")
					return this.filterByEncryptedId(keyToEncryptedIndexEntries)
				})
				.then((keyToEncryptedIndexEntries) => {
					markEnd("_filterByEncryptedId")
					markStart("_decryptSearchResult")
					return this.decryptSearchResult(keyToEncryptedIndexEntries)
				})
				.then((keyToIndexEntries) => {
					markEnd("_decryptSearchResult")
					markStart("_filterByTypeAndAttributeAndTime")
					return this.filterByTypeAndAttributeAndTime(keyToIndexEntries, searchResult.restriction)
				})
				.then((keyToIndexEntries) => {
					markEnd("_filterByTypeAndAttributeAndTime")
					markStart("_reduceWords")
					return this.reduceWords(keyToIndexEntries, searchResult.matchWordOrder)
				})
				.then((searchIndexEntries) => {
					markEnd("_reduceWords")
					markStart("_reduceToUniqueElementIds")
					return this.reduceToUniqueElementIds(searchIndexEntries, searchResult)
				})
				.then((additionalEntries) => {
					markEnd("_reduceToUniqueElementIds")
					return additionalEntries.concat(searchResult.moreResults)
				})
		}

		return moreResultsEntries
			.then((searchIndexEntries: MoreResultsIndexEntry[]) => {
				markStart("_filterByListIdAndGroupSearchResults")
				return this.filterByListIdAndGroupSearchResults(searchIndexEntries, searchResult, maxResults)
			})
			.then((result) => {
				markEnd("_filterByListIdAndGroupSearchResults")
				if (typeof self !== "undefined") {
					printMeasure("query: " + searchResult.query + ", maxResults: " + String(maxResults), [
						"findIndexEntries",
						"_filterByEncryptedId",
						"_decryptSearchResult",
						"_filterByTypeAndAttributeAndTime",
						"_reduceWords",
						"_reduceToUniqueElementIds",
						"_filterByListIdAndGroupSearchResults",
					])
				}
				return result
			})
	}

	/**
	 * Adds suggestions for the given searchToken to the searchResult until at least minSuggestionCount results are existing
	 */
	private addSuggestions(searchToken: string, suggestionFacade: SuggestionFacade<any>, minSuggestionCount: number, searchResult: SearchResult): Promise<any> {
		let suggestions = suggestionFacade.getSuggestions(searchToken)
		return promiseMap(suggestions, (suggestion) => {
			if (searchResult.results.length < minSuggestionCount) {
				const suggestionResult: SearchResult = {
					query: suggestion,
					restriction: searchResult.restriction,
					results: searchResult.results,
					currentIndexTimestamp: searchResult.currentIndexTimestamp,
					lastReadSearchIndexRow: [[suggestion, null]],
					matchWordOrder: false,
					moreResults: [],
					moreResultsEntries: [],
				}
				return this.startOrContinueSearch(suggestionResult)
			}
		})
	}

	private findIndexEntries(searchResult: SearchResult, maxResults: number | null | undefined): Promise<KeyToEncryptedIndexEntries[]> {
		const typeInfo = typeRefToTypeInfo(searchResult.restriction.type)
		const firstSearchTokenInfo = searchResult.lastReadSearchIndexRow[0]
		// First read all metadata to narrow time range we search in.
		return this.db.dbFacade.createTransaction(true, [SearchIndexOS, SearchIndexMetaDataOS]).then((transaction) => {
			return this.promiseMapCompat(searchResult.lastReadSearchIndexRow, (tokenInfo, index) => {
				const [searchToken] = tokenInfo
				let indexKey = encryptIndexKeyBase64(this.db.key, searchToken, this.db.iv)
				return transaction.get(SearchIndexMetaDataOS, indexKey, SearchIndexWordsIndex).then((metaData: SearchIndexMetaDataDbRow | null) => {
					if (!metaData) {
						tokenInfo[1] = 0 // "we've read all" (because we don't have anything

						// If there's no metadata for key, return empty result
						return {
							id: -index,
							word: indexKey,
							rows: [],
						}
					}

					return decryptMetaData(this.db.key, metaData)
				})
			})
				.thenOrApply((metaRows) => {
					// Find index entry rows in which we will search.
					const rowsToReadForIndexKeys = this.findRowsToReadFromMetaData(firstSearchTokenInfo, metaRows, typeInfo, maxResults)

					// Iterate each query token
					return this.promiseMapCompat(rowsToReadForIndexKeys, (rowsToRead: RowsToReadForIndexKey) => {
						// For each token find token entries in the rows we've found
						return this.promiseMapCompat(rowsToRead.rows, (entry) => this.findEntriesForMetadata(transaction, entry))
							.thenOrApply((a) => a.flat())
							.thenOrApply((indexEntries: EncryptedSearchIndexEntry[]) => {
								return indexEntries.map((entry) => ({
									encEntry: entry,
									idHash: arrayHash(getIdFromEncSearchIndexEntry(entry)),
								}))
							})
							.thenOrApply((indexEntries: EncryptedSearchIndexEntryWithHash[]) => {
								return {
									indexKey: rowsToRead.indexKey,
									indexEntries: indexEntries,
								}
							}).value
					}).value
				})
				.toPromise()
		})
	}

	private findRowsToReadFromMetaData(
		firstTokenInfo: [string, number | null],
		safeMetaDataRows: Array<SearchIndexMetaDataRow>,
		typeInfo: TypeInfo,
		maxResults: number | null | undefined,
	): Array<RowsToReadForIndexKey> {
		// "Leading row" narrows down time range in which we search in this iteration
		// Doesn't matter for correctness which one it is (because query is always AND) but matters for performance
		// For now arbitrarily picked first (usually it's the most specific part anyway)
		const leadingRow = safeMetaDataRows[0]
		const otherRows = safeMetaDataRows.slice(1)

		const rangeForLeadingRow = this.findRowsToRead(leadingRow, typeInfo, firstTokenInfo[1] || Number.MAX_SAFE_INTEGER, maxResults)

		const rowsForLeadingRow = [
			{
				indexKey: leadingRow.word,
				rows: rangeForLeadingRow.metaEntries,
			},
		]
		firstTokenInfo[1] = rangeForLeadingRow.oldestTimestamp
		const rowsForOtherRows = otherRows.map((r) => {
			return {
				indexKey: r.word,
				rows: this.findRowsToReadByTimeRange(r, typeInfo, rangeForLeadingRow.newestRowTimestamp, rangeForLeadingRow.oldestTimestamp),
			}
		})
		return rowsForLeadingRow.concat(rowsForOtherRows)
	}

	private findEntriesForMetadata(transaction: DbTransaction, entry: SearchIndexMetadataEntry): Promise<EncryptedSearchIndexEntry[]> {
		return transaction.get(SearchIndexOS, entry.key).then((indexEntriesRow) => {
			if (!indexEntriesRow) return []
			const result = new Array(entry.size)
			iterateBinaryBlocks(indexEntriesRow as Uint8Array, (block, s, e, iteration) => {
				result[iteration] = block
			})
			return result
		})
	}

	private findRowsToReadByTimeRange(
		metaData: SearchIndexMetaDataRow,
		typeInfo: TypeInfo,
		fromNewestTimestamp: number,
		toOldestTimestamp: number,
	): Array<SearchIndexMetadataEntry> {
		const filteredRows = metaData.rows.filter((r) => r.app === typeInfo.appId && r.type === typeInfo.typeId)
		filteredRows.reverse()
		const passedRows: SearchIndexMetadataEntry[] = []

		for (let row of filteredRows) {
			if (row.oldestElementTimestamp < fromNewestTimestamp) {
				passedRows.push(row)

				if (row.oldestElementTimestamp <= toOldestTimestamp) {
					break
				}
			}
		}

		return passedRows
	}

	private findRowsToRead(
		metaData: SearchIndexMetaDataRow,
		typeInfo: TypeInfo,
		mustBeOlderThan: number,
		maxResults: number | null | undefined,
	): {
		metaEntries: Array<SearchIndexMetadataEntry>
		oldestTimestamp: number
		newestRowTimestamp: number
	} {
		const filteredRows = metaData.rows.filter((r) => r.app === typeInfo.appId && r.type === typeInfo.typeId)
		filteredRows.reverse()
		let entitiesToRead = 0
		let lastReadRowTimestamp = 0
		let newestRowTimestamp = Number.MAX_SAFE_INTEGER
		let rowsToRead

		if (maxResults) {
			rowsToRead = []

			for (let r of filteredRows) {
				if (r.oldestElementTimestamp < mustBeOlderThan) {
					if (entitiesToRead < 1000) {
						entitiesToRead += r.size
						lastReadRowTimestamp = r.oldestElementTimestamp
						rowsToRead.push(r)
					} else {
						break
					}
				} else {
					newestRowTimestamp = r.oldestElementTimestamp
				}
			}
		} else {
			rowsToRead = filteredRows
		}

		return {
			metaEntries: rowsToRead,
			oldestTimestamp: lastReadRowTimestamp,
			newestRowTimestamp: newestRowTimestamp,
		}
	}

	/**
	 * Reduces the search result by filtering out all mailIds that don't match all search tokens
	 */
	private filterByEncryptedId(results: KeyToEncryptedIndexEntries[]): KeyToEncryptedIndexEntries[] {
		let matchingEncIds: Set<number> | null = null
		for (const keyToEncryptedIndexEntry of results) {
			if (matchingEncIds == null) {
				matchingEncIds = new Set(keyToEncryptedIndexEntry.indexEntries.map((entry) => entry.idHash))
			} else {
				const filtered = new Set<number>()
				for (const indexEntry of keyToEncryptedIndexEntry.indexEntries) {
					if (matchingEncIds.has(indexEntry.idHash)) {
						filtered.add(indexEntry.idHash)
					}
				}
				matchingEncIds = filtered
			}
		}
		return results.map((r) => {
			return {
				indexKey: r.indexKey,
				indexEntries: r.indexEntries.filter((entry) => matchingEncIds?.has(entry.idHash)),
			}
		})
	}

	private decryptSearchResult(results: KeyToEncryptedIndexEntries[]): KeyToIndexEntries[] {
		return results.map((searchResult) => {
			return {
				indexKey: searchResult.indexKey,
				indexEntries: searchResult.indexEntries.map((entry) => decryptSearchIndexEntry(this.db.key, entry.encEntry, this.db.iv)),
			}
		})
	}

	private filterByTypeAndAttributeAndTime(results: KeyToIndexEntries[], restriction: SearchRestriction): KeyToIndexEntries[] {
		// first filter each index entry by itself
		let endTimestamp = this.getSearchEndTimestamp(restriction)

		const minIncludedId = timestampToGeneratedId(endTimestamp)
		const maxExcludedId = restriction.start ? timestampToGeneratedId(restriction.start + 1) : null
		for (const result of results) {
			result.indexEntries = result.indexEntries.filter((entry) => {
				return this.isValidAttributeAndTime(restriction, entry, minIncludedId, maxExcludedId)
			})
		}
		// now filter all ids that are in all of the search words
		let matchingIds: Set<Id> | null = null
		for (const keyToIndexEntry of results) {
			if (!matchingIds) {
				matchingIds = new Set(keyToIndexEntry.indexEntries.map((entry) => entry.id))
			} else {
				let filtered = new Set<Id>()
				for (const entry of keyToIndexEntry.indexEntries) {
					if (matchingIds.has(entry.id)) {
						filtered.add(entry.id)
					}
				}
				matchingIds = filtered
			}
		}
		return results.map((r) => {
			return {
				indexKey: r.indexKey,
				indexEntries: r.indexEntries.filter((entry) => matchingIds?.has(entry.id)),
			}
		})
	}

	private isValidAttributeAndTime(restriction: SearchRestriction, entry: SearchIndexEntry, minIncludedId: Id, maxExcludedId: Id | null): boolean {
		if (restriction.attributeIds) {
			if (!contains(restriction.attributeIds, entry.attribute)) {
				return false
			}
		}

		if (maxExcludedId) {
			// timestampToGeneratedId provides the lowest id with the given timestamp (server id and counter set to 0),
			// so we add one millisecond to make sure all ids of the timestamp are covered
			if (!firstBiggerThanSecond(maxExcludedId, entry.id)) {
				return false
			}
		}

		return !firstBiggerThanSecond(minIncludedId, entry.id)
	}

	private reduceWords(results: KeyToIndexEntries[], matchWordOrder: boolean): ReadonlyArray<DecryptedSearchIndexEntry> {
		if (matchWordOrder) {
			return results[0].indexEntries.filter((firstWordEntry) => {
				// reduce the filtered positions for this first word entry and its attribute with each next word to those that are in order
				let filteredPositions = firstWordEntry.positions.slice()

				for (let i = 1; i < results.length; i++) {
					let entry = results[i].indexEntries.find((e) => e.id === firstWordEntry.id && e.attribute === firstWordEntry.attribute)

					if (entry) {
						filteredPositions = filteredPositions.filter((firstWordPosition) =>
							neverNull(entry).positions.find((position) => position === firstWordPosition + i),
						)
					} else {
						// the id was probably not found for the same attribute as the current filtered positions, so we could not find all words in order in the same attribute
						filteredPositions = []
					}
				}

				return filteredPositions.length > 0
			})
		} else {
			// all ids must appear in all words now, so we can use any of the entries lists
			return results[0].indexEntries
		}
	}

	private reduceToUniqueElementIds(results: ReadonlyArray<DecryptedSearchIndexEntry>, previousResult: SearchResult): ReadonlyArray<MoreResultsIndexEntry> {
		const uniqueIds = new Set<string>()
		return results.filter((entry) => {
			if (!uniqueIds.has(entry.id) && !previousResult.results.some((r) => r[1] === entry.id)) {
				uniqueIds.add(entry.id)
				return true
			} else {
				return false
			}
		})
	}

	private filterByListIdAndGroupSearchResults(
		indexEntries: Array<MoreResultsIndexEntry>,
		searchResult: SearchResult,
		maxResults: number | null | undefined,
	): Promise<void> {
		indexEntries.sort((l, r) => compareNewestFirst(l.id, r.id))
		// We filter out everything we've processed from moreEntries, even if we didn't include it
		// downcast: Array of optional elements in not subtype of non-optional elements
		const entriesCopy: Array<MoreResultsIndexEntry | null> = downcast(indexEntries.slice())
		// Results are added in the random order and we may filter some of them out. We need to sort them.
		// Use separate array to only sort new results and not all of them.
		return this.db.dbFacade
			.createTransaction(true, [ElementDataOS])
			.then((transaction) =>
				// As an attempt to optimize search we look for items in parallel. Promise.map iterates in arbitrary order!
				// BUT! we have to look at all of them! Otherwise, we may return them in the wrong order.
				// We cannot return elements 10, 15, 20 if we didn't return element 5 first, no one will ask for it later.
				// The best thing performance-wise would be to split into chunks of certain length and process them in parallel and stop after certain chunk.
				promiseMap(
					indexEntries.slice(0, maxResults || indexEntries.length + 1),
					async (entry, index) => {
						return transaction.get(ElementDataOS, uint8ArrayToBase64(entry.encId)).then((elementData: ElementDataDbRow | null) => {
							// mark result index id as processed to not query result in next load more operation
							entriesCopy[index] = null

							if (elementData) {
								return [elementData[0], entry.id] as IdTuple
							} else {
								return null
							}
						})
					},
					{
						concurrency: 5,
					},
				),
			)
			.then((intermediateResults) => intermediateResults.filter(isNotNull))
			.then(async (intermediateResults) => {
				// apply folder restrictions to intermediateResults

				if (isEmpty(searchResult.restriction.folderIds)) {
					// no folder restrictions (ALL)
					return intermediateResults
				} else {
					// some folder restrictions (e.g. INBOX)

					// With the new mailSet architecture (static mail lists) we need to load every mail
					// in order to check in which mailSet (folder) a mail is included in.
					const mails = await Promise.all(
						intermediateResults.map((intermediateResultId) =>
							this.entityClient.load(MailTypeRef, intermediateResultId).catch(
								ofClass(NotFoundError, () => {
									console.log(`Could not find updated mail ${JSON.stringify(intermediateResultId)}`)
									return null
								}),
							),
						),
					)
					return mails
						.filter(isNotNull)
						.filter((mail) => {
							let folderIds: Array<Id> = mail.sets.map((setId) => elementIdPart(setId))
							return folderIds.some((folderId) => searchResult.restriction.folderIds.includes(folderId))
						})
						.map((mail) => mail._id)
				}
			})
			.then((newResults) => {
				searchResult.results.push(...(newResults as IdTuple[]))
				searchResult.moreResults = entriesCopy.filter(isNotNull)
			})
	}

	async getMoreSearchResults(searchResult: SearchResult, moreResultCount: number): Promise<SearchResult> {
		await this.startOrContinueSearch(searchResult, moreResultCount)
		return searchResult
	}

	private getSearchEndTimestamp(restriction: SearchRestriction): number {
		if (restriction.end) {
			return restriction.end
		} else if (isSameTypeRef(MailTypeRef, restriction.type)) {
			return this.mailIndexer.currentIndexTimestamp === NOTHING_INDEXED_TIMESTAMP ? Date.now() : this.mailIndexer.currentIndexTimestamp
		} else {
			return FULL_INDEXED_TIMESTAMP
		}
	}
}

function normalizeQuery(query: string): string {
	return tokenize(query).join(" ")
}
