import { NotAuthorizedError, NotFoundError } from "../../../common/api/common/error/RestError.js"
import type { Contact, ContactList } from "../../../common/api/entities/tutanota/TypeRefs.js"
import { ContactTypeRef } from "../../../common/api/entities/tutanota/TypeRefs.js"
import { typeModels as tutanotaModels } from "../../../common/api/entities/tutanota/TypeModels.js"
import type { Db, GroupData, IndexUpdate, SearchIndexEntry } from "../../../common/api/worker/search/SearchTypes.js"
import { _createNewIndexUpdate, typeRefToTypeInfo } from "../../../common/api/worker/search/IndexUtils.js"
import { neverNull, noOp, ofClass, promiseMap, tokenize } from "@tutao/tutanota-utils"
import { FULL_INDEXED_TIMESTAMP, OperationType } from "../../../common/api/common/TutanotaConstants.js"
import { IndexerCore } from "./IndexerCore.js"
import { SuggestionFacade } from "./SuggestionFacade.js"
import type { EntityUpdate } from "../../../common/api/entities/sys/TypeRefs.js"
import { EntityClient } from "../../../common/api/common/EntityClient.js"
import { GroupDataOS, MetaDataOS } from "../../../common/api/worker/search/IndexTables.js"
import { AttributeModel } from "../../../common/api/common/AttributeModel"
import { EntityUpdateData } from "../../../common/api/common/utils/EntityUpdateUtils"

export class ContactIndexer {
	_core: IndexerCore
	_db: Db
	_entity: EntityClient
	suggestionFacade: SuggestionFacade<Contact>

	constructor(core: IndexerCore, db: Db, entity: EntityClient, suggestionFacade: SuggestionFacade<Contact>) {
		this._core = core
		this._db = db
		this._entity = entity
		this.suggestionFacade = suggestionFacade
	}

	createContactIndexEntries(contact: Contact): Map<string, SearchIndexEntry[]> {
		const ContactModel = tutanotaModels[ContactTypeRef.typeId.toString()]
		let keyToIndexEntries = this._core.createIndexEntriesForAttributes(contact, [
			{
				attribute: AttributeModel.getModelValue(ContactModel, "firstName"),
				value: () => contact.firstName,
			},
			{
				attribute: AttributeModel.getModelValue(ContactModel, "lastName"),
				value: () => contact.lastName,
			},
			{
				attribute: AttributeModel.getModelValue(ContactModel, "nickname"),
				value: () => contact.nickname || "",
			},
			{
				attribute: AttributeModel.getModelValue(ContactModel, "role"),
				value: () => contact.role,
			},
			{
				attribute: AttributeModel.getModelValue(ContactModel, "title"),
				value: () => contact.title || "",
			},
			{
				attribute: AttributeModel.getModelValue(ContactModel, "comment"),
				value: () => contact.comment,
			},
			{
				attribute: AttributeModel.getModelValue(ContactModel, "company"),
				value: () => contact.company,
			},
			{
				attribute: AttributeModel.getModelAssociation(ContactModel, "addresses"),
				value: () => contact.addresses.map((a) => a.address).join(","),
			},
			{
				attribute: AttributeModel.getModelAssociation(ContactModel, "mailAddresses"),
				value: () => contact.mailAddresses.map((cma) => cma.address).join(","),
			},
			{
				attribute: AttributeModel.getModelAssociation(ContactModel, "phoneNumbers"),
				value: () => contact.phoneNumbers.map((pn) => pn.number).join(","),
			},
			{
				attribute: AttributeModel.getModelAssociation(ContactModel, "socialIds"),
				value: () => contact.socialIds.map((s) => s.socialId).join(","),
			},
		])

		this.suggestionFacade.addSuggestions(this._getSuggestionWords(contact))
		return keyToIndexEntries
	}

	_getSuggestionWords(contact: Contact): string[] {
		return tokenize(contact.firstName + " " + contact.lastName + " " + contact.mailAddresses.map((ma) => ma.address).join(" "))
	}

	processNewContact(event: EntityUpdateData): Promise<
		| {
				contact: Contact
				keyToIndexEntries: Map<string, SearchIndexEntry[]>
		  }
		| null
		| undefined
	> {
		return this._entity
			.load(ContactTypeRef, [event.instanceListId, event.instanceId])
			.then((contact) => {
				let keyToIndexEntries = this.createContactIndexEntries(contact)
				return this.suggestionFacade.store().then(() => {
					return {
						contact,
						keyToIndexEntries,
					}
				})
			})
			.catch(
				ofClass(NotFoundError, () => {
					console.log("tried to index non existing contact")
					return null
				}),
			)
			.catch(
				ofClass(NotAuthorizedError, () => {
					console.log("tried to index contact without permission")
					return null
				}),
			)
	}

	async getIndexTimestamp(contactList: ContactList): Promise<number | null> {
		const t = await this._db.dbFacade.createTransaction(true, [MetaDataOS, GroupDataOS])
		const groupId = neverNull(contactList._ownerGroup)
		return t.get(GroupDataOS, groupId).then((groupData: GroupData | null) => {
			return groupData ? groupData.indexTimestamp : null
		})
	}

	/**
	 * Indexes the contact list if it is not yet indexed.
	 */
	async indexFullContactList(contactList: ContactList): Promise<any> {
		const groupId = neverNull(contactList._ownerGroup)
		let indexUpdate = _createNewIndexUpdate(typeRefToTypeInfo(ContactTypeRef))
		try {
			const contacts = await this._entity.loadAll(ContactTypeRef, contactList.contacts)
			for (const contact of contacts) {
				let keyToIndexEntries = this.createContactIndexEntries(contact)
				this._core.encryptSearchIndexEntries(contact._id, neverNull(contact._ownerGroup), keyToIndexEntries, indexUpdate)
			}
			return Promise.all([
				this._core.writeIndexUpdate(
					[
						{
							groupId,
							indexTimestamp: FULL_INDEXED_TIMESTAMP,
						},
					],
					indexUpdate,
				),
				this.suggestionFacade.store(),
			])
		} catch (e) {
			if (e instanceof NotFoundError) {
				return Promise.resolve()
			}
			throw e
		}
	}

	processEntityEvents(events: EntityUpdateData[], groupId: Id, batchId: Id, indexUpdate: IndexUpdate): Promise<void> {
		return promiseMap(events, async (event) => {
			if (event.operation === OperationType.CREATE) {
				await this.processNewContact(event).then((result) => {
					if (result) {
						this._core.encryptSearchIndexEntries(result.contact._id, neverNull(result.contact._ownerGroup), result.keyToIndexEntries, indexUpdate)
					}
				})
			} else if (event.operation === OperationType.UPDATE) {
				await Promise.all([
					this._core._processDeleted(event, indexUpdate),
					this.processNewContact(event).then((result) => {
						if (result) {
							this._core.encryptSearchIndexEntries(
								result.contact._id,
								neverNull(result.contact._ownerGroup),
								result.keyToIndexEntries,
								indexUpdate,
							)
						}
					}),
				])
			} else if (event.operation === OperationType.DELETE) {
				await this._core._processDeleted(event, indexUpdate)
			}
		}).then(noOp)
	}
}
