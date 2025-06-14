import { ListElementEntity, ServerModelParsedInstance, TypeModel } from "../../common/EntityTypes.js"
import { CalendarEvent, CalendarEventTypeRef, Mail } from "../../entities/tutanota/TypeRefs.js"
import { freezeMap, getTypeString, TypeRef } from "@tutao/tutanota-utils"
import { CUSTOM_MAX_ID, CUSTOM_MIN_ID, elementIdPart, firstBiggerThanSecond, getElementId, LOAD_MULTIPLE_LIMIT } from "../../common/utils/EntityUtils.js"
import { CacheStorage, ExposedCacheStorage, Range } from "./DefaultEntityRestCache.js"
import { EntityRestClient } from "./EntityRestClient.js"
import { ProgrammingError } from "../../common/error/ProgrammingError.js"
import { EntityUpdate } from "../../entities/sys/TypeRefs"
import { AttributeModel } from "../../common/AttributeModel"
import { TypeModelResolver } from "../../common/EntityFunctions"
import { EntityUpdateData } from "../../common/utils/EntityUpdateUtils"

/**
 * update when implementing custom cache handlers.
 * add new types to the union when implementing new
 * custom cache handlers.
 */
type CustomCacheHandledType = never | CalendarEvent | Mail

/**
 * makes sure that any {ref<A>, handler<A>} pair passed to
 * the constructor uses the same A for both props and that they
 * are types for which we actually do custom handling.
 */
type CustomCacheHandlerMapping = CustomCacheHandledType extends infer A
	? A extends ListElementEntity
		? { ref: TypeRef<A>; handler: CustomCacheHandler<A> }
		: never
	: never

/**
 * wrapper for a TypeRef -> CustomCacheHandler map that's needed because we can't
 * use TypeRefs directly as map keys due to object identity not matching.
 *
 * it is mostly read-only
 */
export class CustomCacheHandlerMap {
	private readonly handlers: ReadonlyMap<string, CustomCacheHandler<ListElementEntity>>

	constructor(...args: ReadonlyArray<CustomCacheHandlerMapping>) {
		const handlers: Map<string, CustomCacheHandler<ListElementEntity>> = new Map()
		for (const { ref, handler } of args) {
			const key = getTypeString(ref)
			handlers.set(key, handler)
		}
		this.handlers = freezeMap(handlers)
	}

	get<T extends ListElementEntity>(typeRef: TypeRef<T>): CustomCacheHandler<T> | undefined {
		const typeId = getTypeString(typeRef)
		// map is frozen after the constructor. constructor arg types are set up to uphold this invariant.
		return this.handlers.get(typeId) as CustomCacheHandler<T> | undefined
	}
}

/**
 * Some types are not cached like other types, for example because their custom Ids are not sortable.
 * make sure to update CustomHandledType when implementing this for a new type.
 */
export interface CustomCacheHandler<T extends ListElementEntity> {
	loadRange?: (storage: ExposedCacheStorage, listId: Id, start: Id, count: number, reverse: boolean) => Promise<T[]>

	getElementIdsInCacheRange?: (storage: ExposedCacheStorage, listId: Id, ids: Array<Id>) => Promise<Array<Id>>

	shouldLoadOnCreateEvent?: (event: EntityUpdateData) => Promise<boolean>
}

/**
 * implements range loading in JS because the custom Ids of calendar events prevent us from doing
 * this effectively in the database.
 */
export class CustomCalendarEventCacheHandler implements CustomCacheHandler<CalendarEvent> {
	constructor(private readonly entityRestClient: EntityRestClient, private readonly typeModelResolver: TypeModelResolver) {}

	async loadRange(storage: CacheStorage, listId: Id, start: Id, count: number, reverse: boolean): Promise<CalendarEvent[]> {
		const range = await storage.getRangeForList(CalendarEventTypeRef, listId)
		const typeModel = await this.typeModelResolver.resolveServerTypeReference(CalendarEventTypeRef)

		// if offline db for this list is empty load from server
		let rawList: Array<ServerModelParsedInstance> = []
		if (range == null) {
			let chunk: Array<ServerModelParsedInstance> = []
			let currentMinId = CUSTOM_MIN_ID
			while (true) {
				chunk = await this.entityRestClient.loadParsedInstancesRange(CalendarEventTypeRef, listId, currentMinId, LOAD_MULTIPLE_LIMIT, false)
				rawList.push(...chunk)
				if (chunk.length < LOAD_MULTIPLE_LIMIT) break
				const lastEvent = chunk[chunk.length - 1]
				currentMinId = eventElementId(typeModel, lastEvent)
			}
			for (const event of rawList) {
				await storage.put(CalendarEventTypeRef, event)
			}

			// we have all events now
			await storage.setNewRangeForList(CalendarEventTypeRef, listId, CUSTOM_MIN_ID, CUSTOM_MAX_ID)
		} else {
			this.assertCorrectRange(range)
			rawList = await storage.getWholeListParsed(CalendarEventTypeRef, listId)
			console.log(`CalendarEvent list ${listId} has ${rawList.length} events`)
		}
		const unsortedList = await this.entityRestClient.mapInstancesToEntity(CalendarEventTypeRef, rawList)

		const sortedList = reverse
			? unsortedList
					.filter((calendarEvent) => firstBiggerThanSecond(start, getElementId(calendarEvent), typeModel))
					.sort((a, b) => (firstBiggerThanSecond(getElementId(b), getElementId(a), typeModel) ? 1 : -1))
			: unsortedList
					.filter((calendarEvent) => firstBiggerThanSecond(getElementId(calendarEvent), start, typeModel))
					.sort((a, b) => (firstBiggerThanSecond(getElementId(a), getElementId(b), typeModel) ? 1 : -1))
		return sortedList.slice(0, count)
	}

	private assertCorrectRange(range: Range) {
		if (range.lower !== CUSTOM_MIN_ID || range.upper !== CUSTOM_MAX_ID) {
			throw new ProgrammingError(`Invalid range for CalendarEvent: ${JSON.stringify(range)}`)
		}
	}

	async getElementIdsInCacheRange(storage: CacheStorage, listId: Id, ids: Array<Id>): Promise<Array<Id>> {
		const range = await storage.getRangeForList(CalendarEventTypeRef, listId)
		if (range) {
			this.assertCorrectRange(range)
			// assume none of the given Ids are already cached to make sure they are loaded now
			return ids
		} else {
			return []
		}
	}
}

export class CustomMailEventCacheHandler implements CustomCacheHandler<Mail> {
	async shouldLoadOnCreateEvent(): Promise<boolean> {
		// New emails should be pre-cached.
		//  - we need them to display the folder contents
		//  - will very likely be loaded by indexer later
		//  - we might have the instance in offline cache already because of notification process
		return true
	}
}

function eventElementId(typeModel: TypeModel, lastEvent: ServerModelParsedInstance): Id {
	const lastEventId = AttributeModel.getAttribute<IdTuple>(lastEvent, "_id", typeModel)
	return elementIdPart(lastEventId)
}
