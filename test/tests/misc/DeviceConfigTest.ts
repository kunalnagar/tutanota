import o from "@tutao/otest"
import {
	DeviceConfig,
	DeviceConfigCredentials,
	ListAutoSelectBehavior,
	MailListDisplayMode,
	migrateConfigV2to3,
} from "../../../src/common/misc/DeviceConfig.js"
import { matchers, object, when } from "testdouble"
import { verify } from "@tutao/tutanota-test-utils"
import { CredentialEncryptionMode } from "../../../src/common/misc/credentials/CredentialEncryptionMode.js"
import { CredentialType } from "../../../src/common/misc/credentials/CredentialType.js"

o.spec("DeviceConfig", function () {
	o.spec("migrateConfig", function () {
		o.test("migrating from v2 to v3 preserves internal logins", function () {
			const oldConfig: any = {
				_version: 2,
				_credentials: [
					{
						mailAddress: "internal@example.com",
						userId: "internalUserId",
						accessToken: "internalAccessToken",
						encryptedPassword: "internalEncPassword",
					},
					{
						mailAddress: "externalUserId",
						userId: "externalUserId",
						accessToken: "externalAccessToken",
						encryptedPassword: "externalEncPassword",
					},
				],
			}

			migrateConfigV2to3(oldConfig)

			const expectedCredentialsAfterMigration: Record<string, Omit<DeviceConfigCredentials, "databaseKey">> = {
				internalUserId: {
					credentialInfo: {
						login: "internal@example.com",
						userId: "internalUserId",
						type: CredentialType.Internal,
					},
					accessToken: "internalAccessToken",
					encryptedPassword: "internalEncPassword",
					encryptedPassphraseKey: null,
				},
				externalUserId: {
					credentialInfo: {
						login: "externalUserId",
						userId: "externalUserId",
						type: CredentialType.External,
					},
					accessToken: "externalAccessToken",
					encryptedPassword: "externalEncPassword",
					encryptedPassphraseKey: null,
				},
			}

			o(oldConfig._credentials).deepEquals(expectedCredentialsAfterMigration)
		})

		o.test("migrating from v4 to v5 sets mailListDisplayMode to MAILS", function () {
			const oldConfig: any = {
				_version: 2,
				_credentials: [
					{
						mailAddress: "internal@example.com",
						userId: "internalUserId",
						accessToken: "internalAccessToken",
						encryptedPassword: "internalEncPassword",
					},
					{
						mailAddress: "externalUserId",
						userId: "externalUserId",
						accessToken: "externalAccessToken",
						encryptedPassword: "externalEncPassword",
					},
				],
			}

			const localStorageMock = object<Storage>()
			when(localStorageMock.getItem(DeviceConfig.LocalStorageKey)).thenReturn(JSON.stringify(oldConfig))
			o.check(new DeviceConfig(localStorageMock).getMailListDisplayMode()).equals(MailListDisplayMode.MAILS)
		})
	})

	o.spec("loading config", function () {
		let localStorageMock: Storage

		o.beforeEach(function () {
			localStorageMock = object<Storage>()
		})

		o("Won't write anything to localStorage when signupToken exists and the config version is the same", function () {
			when(localStorageMock.getItem(DeviceConfig.LocalStorageKey)).thenReturn(
				JSON.stringify({
					_version: DeviceConfig.Version,
					_signupToken: "somebase64value",
				}),
			)

			new DeviceConfig(localStorageMock)

			verify(localStorageMock.setItem(DeviceConfig.LocalStorageKey, matchers.anything()), { times: 0 })
		})

		o("When loading, migrations will not lose any config fields", function () {
			const storedInLocalStorage = {
				_version: 2,
				_credentials: [
					{
						mailAddress: "internal@example.com",
						userId: "internalUserId",
						accessToken: "internalAccessToken",
						encryptedPassword: "internalEncPassword",
					},
				],
				_credentialEncryptionMode: CredentialEncryptionMode.DEVICE_LOCK,
				_encryptedCredentialsKey: "somekey",
				acknowledgedNewsItems: [],
				_themeId: "mytheme",
				scheduledAlarmModelVersionPerUser: {},
				_language: "en",
				_defaultCalendarView: {},
				_hiddenCalendars: {},
				expandedMailFolders: {},
				_testDeviceId: "testId",
				_testAssignments: null,
				_signupToken: "signupToken",
				offlineTimeRangeDaysByUser: { userId1: 42 },
				conversationViewShowOnlySelectedMail: false,
				syncContactsWithPhonePreference: {},
				isCalendarDaySelectorExpanded: false,
				mailAutoSelectBehavior: ListAutoSelectBehavior.OLDER,
				isSetupComplete: true,
				lastExternalCalendarSync: {},
				clientOnlyCalendars: new Map(),
				events: [],
				lastRatingPromptedDate: null,
				retryRatingPromptAfter: null,
				scrollTime: 8,
				mailListDisplayMode: MailListDisplayMode.MAILS,
			}

			when(localStorageMock.getItem(DeviceConfig.LocalStorageKey)).thenReturn(JSON.stringify(storedInLocalStorage))

			let storedJson
			when(localStorageMock.setItem(DeviceConfig.LocalStorageKey, matchers.anything())).thenDo((_, json) => {
				storedJson = json
			})

			new DeviceConfig(localStorageMock)

			const migratedConfig = Object.assign({}, storedInLocalStorage, {
				_version: DeviceConfig.Version,
				_credentials: {
					internalUserId: {
						credentialInfo: {
							login: "internal@example.com",
							userId: "internalUserId",
							type: "internal",
						},
						accessToken: "internalAccessToken",
						encryptedPassword: "internalEncPassword",
						encryptedPassphraseKey: null,
					},
				},
				isSetupComplete: true,
				isCredentialsMigratedToNative: false,
			})

			// We can't just call verify on localStorageMock.setItem because the JSON string may not match perfectly
			o(JSON.parse(storedJson)).deepEquals(migratedConfig)
		})

		o.test("new config has MailListDisplayMode CONVERSATION", function () {
			const localStorageMock = object<Storage>()
			when(localStorageMock.getItem(DeviceConfig.LocalStorageKey)).thenReturn(null)

			o.check(new DeviceConfig(localStorageMock).getMailListDisplayMode()).equals(MailListDisplayMode.CONVERSATIONS)
		})
	})
})
