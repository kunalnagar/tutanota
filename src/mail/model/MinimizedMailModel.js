// @flow

import type {Dialog} from "../../gui/base/Dialog"
import type {SendMailModel} from "../editor/SendMailModel"
import {lastThrow, remove} from "../../api/common/utils/ArrayUtils"
import type {EntityUpdateData} from "../../api/main/EventController"
import {EventController, isUpdateForTypeRef} from "../../api/main/EventController"
import type {Mail} from "../../api/entities/tutanota/Mail"
import {MailTypeRef} from "../../api/entities/tutanota/Mail"
import {OperationType} from "../../api/common/TutanotaConstants"
import {isSameId} from "../../api/common/utils/EntityUtils"

export type MinimizedEditor = {
	dialog: Dialog,
	sendMailModel: SendMailModel, // we pass sendMailModel for easier access to contents of mail
	dispose: () => void // disposes dialog and templatePopup eventListeners when minimized mail is removed
}

/**
 * handles minimized Editors
 */
export class MinimizedMailModel {
	_minimizedEditors: Array<MinimizedEditor>;
	_eventController: EventController;

	constructor(eventController: EventController) {
		this._minimizedEditors = []
		this._eventController = eventController
		this._eventController.addEntityListener((updates) => this.entityEventsReceived(updates))
	}

	addEditorDialog(dialog: Dialog, sendMailModel: SendMailModel, dispose: () => void): MinimizedEditor {
		// disallow creation of duplicate minimized mails
		if (!this._minimizedEditors.find(editor => editor.dialog === dialog)) {
			this._minimizedEditors.push({
				sendMailModel: sendMailModel,
				dialog: dialog,
				dispose: dispose
			})
		}
		return lastThrow(this._minimizedEditors)
	}

	entityEventsReceived(updates: $ReadOnlyArray<EntityUpdateData>): Promise<void> {
		return Promise.each(updates, update => {
			if (isUpdateForTypeRef(MailTypeRef, update) && update.operation === OperationType.DELETE) {
				// if we delete a draft that has been minimized, also remove the minimized element accordingly
				const minimizedEditor = this._minimizedEditors.find((e) => {
					const draft = e.sendMailModel.getDraft()
					if (draft) {
						return isSameId(draft._id, [update.instanceListId, update.instanceId])
					}
				})
				if (minimizedEditor) {
					this.removeMinimizedEditor(minimizedEditor)
				}
			}
		}).return()
	}

	// fully removes and reopens clicked mail
	reopenMinimizedEditor(editor: MinimizedEditor): void {
		editor.dialog.show()
		remove(this._minimizedEditors, editor)
	}

	// fully removes clicked mail
	removeMinimizedEditor(editor: MinimizedEditor): void {
		editor.dispose()
		remove(this._minimizedEditors, editor)
	}

	getMinimizedEditors(): Array<MinimizedEditor> {
		return this._minimizedEditors
	}

	getEditorForDraft(mail: Mail): ?MinimizedEditor {
		return this.getMinimizedEditors().find((e) => {
			const draft = e.sendMailModel.getDraft()
			return draft ? isSameId(draft._id, mail._id) : null
		})
	}

}