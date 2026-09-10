package com.rucola.app.data

import androidx.room.*
import androidx.room.migration.Migration
import com.rucola.app.domain.*
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "relationships")
data class RelationshipEntity(
    @PrimaryKey val id: String,
    val partnerNickname: String,
    val ownName: String,
    val partnerColor: String,
    val togetherSince: Long?,
)

@Entity(
    tableName = "messages",
    indices = [Index(value = ["relationshipId", "participant", "isActive"])]
)
data class MessageEntity(
    @PrimaryKey val id: String,
    val relationshipId: String,
    val participant: String,
    val type: String,
    val body: String,
    val createdAt: Long,
    val orderIndex: Long,
    val isActive: Boolean,
    val mediaReference: String?,
    val syncState: String,
)

@Dao
interface RucolaDao {
    @Query("SELECT * FROM relationships LIMIT 1")
    fun relationship(): Flow<RelationshipEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveRelationship(value: RelationshipEntity)

    @Query("SELECT * FROM messages WHERE relationshipId = :relationshipId ORDER BY orderIndex DESC, createdAt DESC, id DESC")
    fun messages(relationshipId: String): Flow<List<MessageEntity>>

    @Query("SELECT COUNT(*) FROM messages WHERE relationshipId = :relationshipId")
    suspend fun messageCount(relationshipId: String): Int

    @Query("UPDATE messages SET isActive = 0 WHERE relationshipId = :relationshipId AND participant = :participant AND isActive = 1")
    suspend fun archiveActive(relationshipId: String, participant: String)

    @Query("SELECT COALESCE(MAX(orderIndex), 0) + 1 FROM messages WHERE relationshipId = :relationshipId")
    suspend fun nextOrderIndex(relationshipId: String): Long

    @Insert
    suspend fun insertMessage(value: MessageEntity)

    @Transaction
    suspend fun replaceActive(message: MessageEntity) {
        archiveActive(message.relationshipId, message.participant)
        insertMessage(message)
    }
}

@Database(entities = [RelationshipEntity::class, MessageEntity::class], version = 3, exportSchema = false)
abstract class RucolaDatabase : RoomDatabase() {
    abstract fun dao(): RucolaDao
}

val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(database: androidx.sqlite.db.SupportSQLiteDatabase) {
        database.execSQL("ALTER TABLE messages ADD COLUMN orderIndex INTEGER NOT NULL DEFAULT 0")
        database.execSQL("ALTER TABLE messages ADD COLUMN mediaReference TEXT")
    }
}

val MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(database: androidx.sqlite.db.SupportSQLiteDatabase) {
        database.execSQL("ALTER TABLE relationships ADD COLUMN ownName TEXT NOT NULL DEFAULT 'me'")
        database.execSQL("ALTER TABLE relationships ADD COLUMN partnerColor TEXT NOT NULL DEFAULT '#8FC56A'")
    }
}

fun RelationshipEntity.toDomain() = Relationship(id, partnerNickname, ownName, partnerColor, togetherSince)
fun MessageEntity.toDomain() = Message(id, relationshipId, Participant.valueOf(participant), MessageType.valueOf(type), body, createdAt, isActive, SyncState.valueOf(syncState), orderIndex, mediaReference)
fun Relationship.toEntity() = RelationshipEntity(id, partnerNickname, ownName, partnerColor, togetherSince)
fun Message.toEntity() = MessageEntity(id, relationshipId, participant.name, type.name, body, createdAt, orderIndex, isActive, mediaReference, syncState.name)