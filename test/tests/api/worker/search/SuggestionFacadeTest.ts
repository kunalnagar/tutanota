/**
 * Created by bdeterding on 13.12.17.
 */
import o from "@tutao/otest"
import { ContactTypeRef } from "../../../../../src/common/api/entities/tutanota/TypeRefs.js"
import { SuggestionFacade } from "../../../../../src/mail-app/workerUtils/index/SuggestionFacade.js"
import { downcast } from "@tutao/tutanota-utils"
import { aes256RandomKey, fixedIv } from "@tutao/tutanota-crypto"
import { SearchTermSuggestionsOS } from "../../../../../src/common/api/worker/search/IndexTables.js"
import { spy } from "@tutao/tutanota-test-utils"
import { ClientModelInfo, ClientTypeModelResolver } from "../../../../../src/common/api/common/EntityFunctions"
import { TypeModel } from "../../../../../src/common/api/common/EntityTypes"
import { Db } from "../../../../../src/common/api/worker/search/SearchTypes"
import { DbFacade } from "../../../../../src/common/api/worker/search/DbFacade"

o.spec("SuggestionFacade test", () => {
	let db: Db
	let facade: SuggestionFacade<any>
	let contactTypeModel: TypeModel
	let clientModelResolver: ClientTypeModelResolver
	o.beforeEach(async function () {
		db = {
			key: aes256RandomKey(),
			iv: fixedIv,
			dbFacade: {} as unknown as DbFacade,
			initialized: Promise.resolve(),
		}
		clientModelResolver = ClientModelInfo.getNewInstanceForTestsOnly()
		facade = new SuggestionFacade(ContactTypeRef, db, clientModelResolver)
		contactTypeModel = await clientModelResolver.resolveClientTypeReference(ContactTypeRef)
	})
	o("add and get suggestion", () => {
		o(facade.getSuggestions("a").join("")).equals("")
		let words = ["a"]
		facade.addSuggestions(words)
		o(facade.getSuggestions("a").join(" ")).equals("a")
		words = ["anton", "arne"]
		facade.addSuggestions(words)
		o(facade.getSuggestions("a").join(" ")).equals("a anton arne")
		words = ["ab", "az", "arne"]
		facade.addSuggestions(words)
		o(facade.getSuggestions("a").join(" ")).equals("a ab anton arne az")
		words = ["aa", "anne", "bernd"]
		facade.addSuggestions(words)
		o(facade.getSuggestions("a").join(" ")).equals("a aa ab anne anton arne az")
		o(facade.getSuggestions("an").join(" ")).equals("anne anton")
		o(facade.getSuggestions("ann").join(" ")).equals("anne")
		o(facade.getSuggestions("anne").join(" ")).equals("anne")
		o(facade.getSuggestions("annet").join(" ")).equals("")
		o(facade.getSuggestions("b").join(" ")).equals("bernd")
		o(facade.getSuggestions("be").join(" ")).equals("bernd")
		o(facade.getSuggestions("ben").join(" ")).equals("")
	})
	o("load empty", () => {
		let transactionMock: any = {}
		transactionMock.get = spy(() => Promise.resolve(null))
		downcast(db.dbFacade).createTransaction = spy(() => Promise.resolve(transactionMock))
		facade.addSuggestions(["aaaaaaa"])
		return facade.load().then(() => {
			o(transactionMock.get.callCount).equals(1)
			o(transactionMock.get.args[0]).equals(SearchTermSuggestionsOS)
			o(transactionMock.get.args[1]).equals(contactTypeModel.name.toLowerCase())
			o(facade.getSuggestions("a").join("")).equals("")
		})
	})
	o("store and load", () => {
		let transactionMock: any = {}
		transactionMock.put = spy(() => Promise.resolve())
		transactionMock.wait = spy(() => Promise.resolve())
		downcast(db.dbFacade).createTransaction = spy(() => Promise.resolve(transactionMock))
		facade.addSuggestions(["aaaa"])
		return facade.store().then(() => {
			o(transactionMock.put.args[0]).equals(SearchTermSuggestionsOS)
			o(transactionMock.put.args[1]).equals(contactTypeModel.name.toLowerCase())
			let encSuggestions = transactionMock.put.args[2]
			facade.addSuggestions(["accc", "bbbb"])
			// insert new values
			o(facade.getSuggestions("a").join(" ")).equals("aaaa accc")
			o(facade.getSuggestions("b").join(" ")).equals("bbbb")
			let transactionLoadMock: any = {}
			downcast(db.dbFacade).createTransaction = spy(() => Promise.resolve(transactionLoadMock))
			transactionLoadMock.get = spy(() => Promise.resolve(encSuggestions))
			return facade.load().then(() => {
				// restored
				o(transactionLoadMock.get.args[0]).equals(SearchTermSuggestionsOS)
				o(transactionLoadMock.get.args[1]).equals(contactTypeModel.name.toLowerCase())
				o(facade.getSuggestions("a").join(" ")).equals("aaaa")
				o(facade.getSuggestions("b").join(" ")).equals("")
			})
		})
	})
})
