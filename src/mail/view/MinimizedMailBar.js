//@flow

import m from "mithril"
import {WindowFacade} from "../../misc/WindowFacade"
import {px, size} from "../../gui/size"
import {MINIMIZED_HEIGHT, MINIMIZED_WIDTH, MinimizedMailElement} from "./MinimizedMailElement"
import type {MinimizedEditor} from "../model/MinimizedMailModel"
import {MinimizedMailModel} from "../model/MinimizedMailModel"
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

export const MAXIMUM_AMOUNT_OF_MINIMIZED_ELEMENTS = 5

export type MinimizedMailBarAttrs = {
	windowFacade: WindowFacade,
	minimizedMailModel: MinimizedMailModel
}

/**
 *  Bar that gets rendered at the bottom of the screen for 5 most recent minimized mails to be displayed in
 *  Renders iff client is not mobile
 */
export class MinimizedMailBar implements MComponent<MinimizedMailBarAttrs> {
	_windowCloseUnsubscribe: () => mixed
	model: MinimizedMailModel

	constructor(vnode: Vnode<MinimizedMailBarAttrs>) {
		this._windowCloseUnsubscribe = () => false
		this.model = vnode.attrs.minimizedMailModel
	}

	view(vnode: Vnode<MinimizedMailBarAttrs>): Children {
		return m(".flex-end.abs", {
				oncreate: () => this._windowCloseUnsubscribe = vnode.attrs.windowFacade.addWindowCloseListener(() => true),
				onremove: () => this._windowCloseUnsubscribe(),
				style: {
					bottom: 0,
					height: px(MINIMIZED_HEIGHT),
					width: px((MINIMIZED_WIDTH * MAXIMUM_AMOUNT_OF_MINIMIZED_ELEMENTS) + (size.vpad_small
						* MAXIMUM_AMOUNT_OF_MINIMIZED_ELEMENTS)), // we currently allow 5 popups with a margin-right of 8px
					right: px(size.hpad_medium)
				}
			}, this.renderMinimizedEditors()
		)
	}

	renderMinimizedEditors(): Children {
		// slice by negative number to get the last x elements of the array
		return this.model._minimizedEditors.slice(-(MAXIMUM_AMOUNT_OF_MINIMIZED_ELEMENTS)).reverse().map(editor => m(MinimizedMailElement, {
			subject: editor.sendMailModel.getSubject(),
			close: () => {
				this.model.reopenMinimizedEditor(editor)
			},
			remove: () => {
				this.model.removeMinimizedEditor(editor)
			}
		}))
	}
}

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
				buttons
			})
		},
		(dom) => transform(transform.type.translateY, -dom.offsetHeight, 0),
		(dom) => transform(transform.type.translateY, 0, -dom.offsetHeight)
	)
}

