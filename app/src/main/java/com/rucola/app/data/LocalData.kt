package com.rucola.app.data

import androidx.room.*
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
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

/** The authoritative active-message pointer for a participant. */
@Entity(
    tableName = "active_message_slots",
    primaryKeys = ["relationshipId", "participant"],
    indices = [Index(value = ["messageId"], unique = true)],
    foreignKeys = [
        ForeignKey(
            entity = MessageEntity::class,
            parentColumns = ["id"],
            childColumns = ["messageId"],
            onDelete = ForeignKey.RESTRICT,
        ),
    ],
)
data class ActiveMessageSlotEntity(
    val relationshipId: String,
    val participant: String,
    val messageId: String,
)

@Dao
interface RucolaDao {
    @Query("SELECT * FROM relationships WHERE id = :relationshipId")
    fun relationship(relationshipId: String): Flow<RelationshipEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveRelationship(value: RelationshipEntity)

    @Query(
        """
        SELECT m.id, m.relationshipId, m.participant, m.type, m.body, m.createdAt,
            m.orderIndex, CASE WHEN s.messageId IS NULL THEN 0 ELSE 1 END AS isActive,
            m.mediaReference, m.syncState
        FROM messages m
        LEFT JOIN active_message_slots s ON s.messageId = m.id
        WHERE m.relationshipId = :relationshipId
        ORDER BY m.orderIndex DESC, m.createdAt DESC, m.id DESC
        """,
    )
    fun messages(relationshipId: String): Flow<List<MessageEntity>>

    @Query("SELECT COUNT(*) FROM messages WHERE relationshipId = :relationshipId")
    suspend fun messageCount(relationshipId: String): Int

    @Query("UPDATE messages SET isActive = 0 WHERE relationshipId = :relationshipId AND participant = :participant AND isActive = 1")
    suspend fun archiveActive(relationshipId: String, participant: String)

    @Query("SELECT COALESCE(MAX(orderIndex), 0) + 1 FROM messages WHERE relationshipId = :relationshipId")
    suspend fun nextOrderIndex(relationshipId: String): Long

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertMessage(value: MessageEntity): Long

    @Query(
        """
        SELECT m.* FROM messages m
        INNER JOIN active_message_slots s ON s.messageId = m.id
        WHERE s.relationshipId = :relationshipId AND s.participant = :participant
        """,
    )
    suspend fun activeMessage(relationshipId: String, participant: String): MessageEntity?

    @Query("UPDATE messages SET isActive = 1 WHERE id = :messageId")
    suspend fun markMessageActive(messageId: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveActiveSlot(value: ActiveMessageSlotEntity)

    @Transaction
    suspend fun replaceActive(message: MessageEntity) {
        if (insertMessage(message.copy(isActive = false)) == -1L) return

        val current = activeMessage(message.relationshipId, message.participant)
        if (current == null || message.sortsAfter(current)) {
            archiveActive(message.relationshipId, message.participant)
            markMessageActive(message.id)
            saveActiveSlot(ActiveMessageSlotEntity(message.relationshipId, message.participant, message.id))
        }
    }
}

@Database(
    entities = [RelationshipEntity::class, MessageEntity::class, ActiveMessageSlotEntity::class],
    version = 4,
    exportSchema = false,
)
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
        database.execSQL("ALTER TABLE relationships ADD COLUMN partnerColor TEXT NOT NULL DEFAULT '$DefaultPartnerColor'")
    }
}

val MIGRATION_3_4 = object : Migration(3, 4) {
    override fun migrate(database: SupportSQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS active_message_slots (
                relationshipId TEXT NOT NULL,
                participant TEXT NOT NULL,
                messageId TEXT NOT NULL,
                PRIMARY KEY(relationshipId, participant),
                FOREIGN KEY(messageId) REFERENCES messages(id) ON DELETE RESTRICT
            )
            """.trimIndent(),
        )
        database.execSQL(
            "CREATE UNIQUE INDEX IF NOT EXISTS index_active_message_slots_messageId ON active_message_slots(messageId)",
        )
        database.execSQL(
            """
            INSERT OR REPLACE INTO active_message_slots (relationshipId, participant, messageId)
            SELECT current.relationshipId, current.participant, current.id
            FROM messages current
            WHERE current.isActive = 1
              AND NOT EXISTS (
                  SELECT 1 FROM messages newer
                  WHERE newer.relationshipId = current.relationshipId
                    AND newer.participant = current.participant
                    AND newer.isActive = 1
                    AND (newer.orderIndex > current.orderIndex
                        OR (newer.orderIndex = current.orderIndex AND newer.createdAt > current.createdAt)
                        OR (newer.orderIndex = current.orderIndex AND newer.createdAt = current.createdAt AND newer.id > current.id))
              )
            """.trimIndent(),
        )
    }
}

fun RelationshipEntity.toDomain() = Relationship(id, partnerNickname, ownName, partnerColor, togetherSince)
fun MessageEntity.toDomain() = Message(id, relationshipId, Participant.valueOf(participant), MessageType.valueOf(type), body, createdAt, isActive, SyncState.valueOf(syncState), orderIndex, mediaReference)
fun Relationship.toEntity() = RelationshipEntity(id, partnerNickname, ownName, partnerColor, togetherSince)
fun Message.toEntity() = MessageEntity(id, relationshipId, participant.name, type.name, body, createdAt, orderIndex, isActive, mediaReference, syncState.name)

private fun MessageEntity.sortsAfter(other: MessageEntity): Boolean =
    compareValuesBy(this, other, MessageEntity::orderIndex, MessageEntity::createdAt, MessageEntity::id) > 0
