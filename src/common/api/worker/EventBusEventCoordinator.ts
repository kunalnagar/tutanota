import { EventBusListener } from "./EventBusClient.js"
import { WsConnectionState } from "../main/WorkerClient.js"
import {
	EntityUpdate,
	GroupKeyUpdateTypeRef,
	UserGroupKeyDistributionTypeRef,
	UserTypeRef,
	WebsocketCounterData,
	WebsocketLeaderStatus,
} from "../entities/sys/TypeRefs.js"
import { ReportedMailFieldMarker } from "../entities/tutanota/TypeRefs.js"
import { WebsocketConnectivityListener } from "../../misc/WebsocketConnectivityModel.js"
import { isAdminClient, isTest } from "../common/Env.js"
import { MailFacade } from "./facades/lazy/MailFacade.js"
import { UserFacade } from "./facades/UserFacade.js"
import { EntityClient } from "../common/EntityClient.js"
import { AccountType, OperationType } from "../common/TutanotaConstants.js"
import { lazyAsync } from "@tutao/tutanota-utils"
import { isSameId } from "../common/utils/EntityUtils.js"
import { ExposedEventController } from "../main/EventController.js"
import { ConfigurationDatabase } from "./facades/lazy/ConfigurationDatabase.js"
import { KeyRotationFacade } from "./facades/KeyRotationFacade.js"
import { CacheManagementFacade } from "./facades/lazy/CacheManagementFacade.js"
import type { QueuedBatch } from "./EventQueue.js"
import { EntityUpdateData, isUpdateForTypeRef } from "../common/utils/EntityUpdateUtils"

/** A bit of glue to distribute event bus events across the app. */
export class EventBusEventCoordinator implements EventBusListener {
	constructor(
		private readonly connectivityListener: WebsocketConnectivityListener,
		private readonly mailFacade: lazyAsync<MailFacade>,
		private readonly userFacade: UserFacade,
		private readonly entityClient: EntityClient,
		private readonly eventController: ExposedEventController,
		private readonly configurationDatabase: lazyAsync<ConfigurationDatabase>,
		private readonly keyRotationFacade: KeyRotationFacade,
		private readonly cacheManagementFacade: lazyAsync<CacheManagementFacade>,
		private readonly sendError: (error: Error) => Promise<void>,
		private readonly appSpecificBatchHandling: (events: readonly EntityUpdateData[], batchId: Id, groupId: Id) => void,
	) {}

	onWebsocketStateChanged(state: WsConnectionState) {
		this.connectivityListener.updateWebSocketState(state)
	}

	async onEntityEventsReceived(events: readonly EntityUpdateData[], batchId: Id, groupId: Id): Promise<void> {
		await this.entityEventsReceived(events)
		await (await this.mailFacade()).entityEventsReceived(events)
		await this.eventController.onEntityUpdateReceived(events, groupId)
		// Call the indexer in this last step because now the processed event is stored and the indexer has a separate event queue that
		// shall not receive the event twice.
		if (!isTest() && !isAdminClient()) {
			const configurationDatabase = await this.configurationDatabase()
			await configurationDatabase.onEntityEventsReceived(events, batchId, groupId)
			this.appSpecificBatchHandling(events, batchId, groupId)
		}
	}

	/**
	 * @param markers only phishing (not spam) marker will be sent as websocket updates
	 */
	async onPhishingMarkersReceived(markers: ReportedMailFieldMarker[]) {
		;(await this.mailFacade()).phishingMarkersUpdateReceived(markers)
	}

	onError(tutanotaError: Error) {
		this.sendError(tutanotaError)
	}

	onLeaderStatusChanged(leaderStatus: WebsocketLeaderStatus) {
		this.connectivityListener.onLeaderStatusChanged(leaderStatus)
		if (!isAdminClient()) {
			const user = this.userFacade.getUser()
			if (leaderStatus.leaderStatus && user && user.accountType !== AccountType.EXTERNAL) {
				this.keyRotationFacade.processPendingKeyRotationsAndUpdates(user)
			} else {
				this.keyRotationFacade.reset()
			}
		}
	}

	onCounterChanged(counter: WebsocketCounterData) {
		this.eventController.onCountersUpdateReceived(counter)
	}

	private async entityEventsReceived(data: readonly EntityUpdateData[]): Promise<void> {
		// This is a compromise to not add entityClient to UserFacade which would introduce a circular dep.
		const groupKeyUpdates: IdTuple[] = [] // GroupKeyUpdates all in the same list
		const user = this.userFacade.getUser()
		if (user == null) return
		for (const update of data) {
			if (update.operation === OperationType.UPDATE && isUpdateForTypeRef(UserTypeRef, update) && isSameId(user._id, update.instanceId)) {
				await this.userFacade.updateUser(await this.entityClient.load(UserTypeRef, user._id))
			} else if (
				(update.operation === OperationType.CREATE || update.operation === OperationType.UPDATE) &&
				isUpdateForTypeRef(UserGroupKeyDistributionTypeRef, update) &&
				isSameId(user.userGroup.group, update.instanceId)
			) {
				await (await this.cacheManagementFacade()).tryUpdatingUserGroupKey()
			} else if (update.operation === OperationType.CREATE && isUpdateForTypeRef(GroupKeyUpdateTypeRef, update)) {
				groupKeyUpdates.push([update.instanceListId, update.instanceId])
			}
		}
		await this.keyRotationFacade.updateGroupMemberships(groupKeyUpdates)
	}
}
