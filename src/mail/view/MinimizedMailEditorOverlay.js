//@flow

import m from "mithril"
import {px} from "../../gui/size"
import type {MinimizedEditor} from "../model/MinimizedMailModel"
import {assertMainOrNode} from "../../api/common/Env"
import {ButtonType} from "../../gui/base/ButtonN"
import {displayOverlay} from "../../gui/base/Overlay"
import {transform} from "../../gui/animation/Animations"
import {NotificationOverlay} from "../../gui/base/NotificationOverlay"
import {lang} from "../../misc/LanguageViewModel"
import {locator} from "../../api/main/MainLocator"
import {promptAndDeleteMails} from "./MailGuiUtils"
import {noOp} from "../../api/common/utils/Utils"
import {Icon} from "../../gui/base/Icon"
import {theme} from "../../gui/theme"
import {Icons} from "../../gui/base/icons/Icons"
import {LayerType} from "../../RootView"
import type {EntityUpdateData} from "../../api/main/EventController"
import {isUpdateForTypeRef} from "../../api/main/EventController"
import {MailTypeRef} from "../../api/entities/tutanota/Mail"
import {OperationType} from "../../api/common/TutanotaConstants"
import {isSameId} from "../../api/common/utils/EntityUtils"

assertMainOrNode()

export function showLatestMinimizedEditor(minimizedEditor: MinimizedEditor) {

	const subject = minimizedEditor.sendMailModel.getSubject()
	const message = subject ? subject : lang.get("newMail_action")

	const buttons = [
		{
			label: "close_alt",
			click: () => {
				closeOverlayFunction()
				locator.minimizedMailModel.removeMinimizedEditor(minimizedEditor)
			},
			type: ButtonType.Secondary
		}, {
			label: "delete_action",
			click: () => {
				closeOverlayFunction()
				let model = minimizedEditor.sendMailModel
				const draft = model._draft
				if (draft) {
					promptAndDeleteMails(model.mails(), [draft], noOp)
				}
			},
			type: ButtonType.Secondary
		}, {
			label: "edit_action",
			click: () => {
				closeOverlayFunction()
				locator.minimizedMailModel.reopenMinimizedEditor(minimizedEditor)
			},
			type: ButtonType.Primary
		}
	]


	const removeDraftListener = (updates: $ReadOnlyArray<EntityUpdateData>, eventOwnerGroupId: Id): Promise<*> => {
		return Promise.each(updates, update => {
			if (isUpdateForTypeRef(MailTypeRef, update) && update.operation === OperationType.DELETE) {
				let draft = minimizedEditor.sendMailModel.getDraft()
				if (draft && isSameId(draft._id, [update.instanceListId, update.instanceId])) {
					closeOverlayFunction()
					locator.minimizedMailModel.removeMinimizedEditor(minimizedEditor)
				}
			}
		})
	}

	const marginRight = 20
	// TODO polish for mobile device
	const closeOverlayFunction = displayOverlay({bottom: px(0), right: px(marginRight), width: px(300), zIndex: LayerType.Minimized}, {
			view: () => m(NotificationOverlay, {
				message: {
					view() {
						return m(".flex.items-center", [
							m(Icon, {icon: Icons.Edit, class: "mr-s icon-large", style: {fill: theme.content_fg}}),
							m(".text-ellipsis", message)
						])
					}
				},
				buttons,
				oncreate: () => {
					locator.eventController.addEntityListener(removeDraftListener)
				},
				onremove: () => {
					locator.eventController.removeEntityListener(removeDraftListener)
				}
			})
		},
		(dom) => transform(transform.type.translateY, -dom.offsetHeight, 0),
		(dom) => transform(transform.type.translateY, 0, -dom.offsetHeight)
	)
}




