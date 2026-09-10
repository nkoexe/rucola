package com.rucola.app.data

import androidx.room.*
import com.rucola.app.domain.*
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "relationships")
data class RelationshipEntity(
    @PrimaryKey val id: String,
    val partnerNickname: String,
    val avatar: String,
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
    val isActive: Boolean,
    val syncState: String,
)

@Dao
interface RucolaDao {
    @Query("SELECT * FROM relationships LIMIT 1")
    fun relationship(): Flow<RelationshipEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveRelationship(value: RelationshipEntity)

    @Query("SELECT * FROM messages WHERE relationshipId = :relationshipId ORDER BY createdAt DESC")
    fun messages(relationshipId: String): Flow<List<MessageEntity>>

    @Query("SELECT COUNT(*) FROM messages WHERE relationshipId = :relationshipId")
    suspend fun messageCount(relationshipId: String): Int

    @Query("UPDATE messages SET isActive = 0 WHERE relationshipId = :relationshipId AND participant = :participant AND isActive = 1")
    suspend fun archiveActive(relationshipId: String, participant: String)

    @Insert
    suspend fun insertMessage(value: MessageEntity)
}

@Database(entities = [RelationshipEntity::class, MessageEntity::class], version = 1, exportSchema = false)
abstract class RucolaDatabase : RoomDatabase() {
    abstract fun dao(): RucolaDao
}

fun RelationshipEntity.toDomain() = Relationship(id, partnerNickname, avatar, togetherSince)
fun MessageEntity.toDomain() = Message(id, relationshipId, Participant.valueOf(participant), MessageType.valueOf(type), body, createdAt, isActive, SyncState.valueOf(syncState))
fun Relationship.toEntity() = RelationshipEntity(id, partnerNickname, avatar, togetherSince)
fun Message.toEntity() = MessageEntity(id, relationshipId, participant.name, type.name, body, createdAt, isActive, syncState.name)