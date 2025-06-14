package de.tutao.tutashared.offline

import android.content.Context
import android.database.Cursor
import android.database.SQLException
import android.util.Log
import de.tutao.tutashared.ipc.DataWrapper
import de.tutao.tutashared.ipc.SqlCipherFacade
import de.tutao.tutashared.ipc.wrap
import kotlinx.coroutines.CompletableDeferred
import net.zetetic.database.sqlcipher.SQLiteDatabase
import java.io.File
import java.util.concurrent.ConcurrentHashMap

class AndroidSqlCipherFacade(private val context: Context) : SqlCipherFacade {
	init {
		System.loadLibrary("sqlcipher")
	}

	// Set db to volatile because we only wrap modifications to db in synchronized yet we still want all access
	// operations to see the latest value
	@Volatile
	private var db: SQLiteDatabase? = null
	private val openedDb: SQLiteDatabase
		get() = db ?: throw OfflineDbClosedError()

	private val listIdLocks: MutableMap<String, CompletableDeferred<Unit>> = ConcurrentHashMap()

	override suspend fun openDb(userId: String, dbKey: DataWrapper) {
		// db is volatile so we see the latest value but it doesn't mean that we won't try to open/delete it in parallel
		// so we need synchronized.
		// Wrap the whole method into synchronized to ensure that no other check or modification can happen in between
		synchronized(this) {
			if (db != null) {
				Log.w(TAG, "opening new database while old one is open")
				closeDbSync()
			}
			db = SQLiteDatabase.openOrCreateDatabase(getDbFile(userId), dbKey.data, null, null)
		}

		// We are using the auto_vacuum=incremental mode to allow for a faster vacuum execution
		// After changing the auto_vacuum mode we need to run "vacuum" once
		// auto_vacuum mode: 0 (NONE) | 1 (FULL) | 2 (INCREMENTAL)
		openedDb.query("PRAGMA auto_vacuum").use { cursor ->
			if (cursor.moveToFirst()) {
				if (cursor.getInt(0) != 2) {
					db?.query("PRAGMA auto_vacuum = incremental")
					Log.d(TAG, "PRAGMA vacuum")
					
				}
			}
		}
		// There are rare occurrences when opening the DB takes a long time.
		// One case is when we open DB from notification process. It might take a few seconds (usually around 2) and
		// during this time writes to the database take longer, sometimes more than a second.
		// This is not a perfect solution but in this particular case it does not matter if the write takes longer.
		openedDb.query("PRAGMA busy_timeout = 5000")

		Log.d(TAG, "DB opened $userId")
	}

	private fun getDbFile(userId: String): File {
		val dbFile = context.getDatabasePath("offline_$userId.sqlite")
		dbFile.parentFile!!.mkdirs()
		if (!dbFile.parentFile!!.exists()) {
			Log.e(TAG, "could not create db path at ${dbFile.path}")
		}
		return dbFile
	}

	private fun closeDbSync() {
		// We are performing defragmentation (incremental_vacuum) the database before closing
		db?.query("PRAGMA incremental_vacuum")
		db?.close()
		db = null
	}

	override suspend fun closeDb() {
		synchronized(this) {
			this.closeDbSync()
		}
	}

	override suspend fun deleteDb(userId: String) {
		synchronized(this) {
			try {
				closeDbSync()
			} finally {
				getDbFile(userId).delete()
			}
		}
	}

	override suspend fun run(query: String, params: List<TaggedSqlValue>) {
		try {
			openedDb.execSQL(query, params.prepare())
		} catch (e: SQLException) {
			Log.e(TAG, "Error when running SQL query `$query`, args[0] ${params.getOrNull(0)}")
			throw e
		}
	}

	override suspend fun get(query: String, params: List<TaggedSqlValue>): Map<String, TaggedSqlValue>? {
		return openedDb.query(query, params.prepare()).use { cursor ->
			if (cursor.moveToNext()) {
				cursor.readRow()
			} else {
				null
			}
		}
	}

	private fun Cursor.readRow(): MutableMap<String, TaggedSqlValue> {
		val columnNames = columnNames
		val result = mutableMapOf<String, TaggedSqlValue>()
		for (name in columnNames) {
			val index = getColumnIndex(name)
			result[name] = when (val type = getType(index)) {
				Cursor.FIELD_TYPE_NULL -> TaggedSqlValue.Null
				Cursor.FIELD_TYPE_BLOB -> TaggedSqlValue.Bytes(getBlob(index).wrap())
				Cursor.FIELD_TYPE_INTEGER -> TaggedSqlValue.Num(getInt(index))
				Cursor.FIELD_TYPE_STRING -> TaggedSqlValue.Str(getString(index))
				else -> error("SQL type is not supported: $type")
			}
		}
		return result
	}

	override suspend fun all(query: String, params: List<TaggedSqlValue>): List<Map<String, TaggedSqlValue>> {
		return openedDb.query(query, params.prepare()).use { cursor ->
			buildList {
				while (cursor.moveToNext()) {
					add(cursor.readRow())
				}
			}
		}
	}

	private fun List<TaggedSqlValue>.prepare() = map { it.unwrap() }.toTypedArray()
}

private const val TAG = "AndroidSqlCipherFacade"

class OfflineDbClosedError : Exception()