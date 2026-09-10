package com.rucola.app.domain

import com.rucola.app.data.RucolaRepository

class SaveSetup(private val repository: RucolaRepository) {
    suspend operator fun invoke(partnerNickname: String, ownName: String, partnerColor: String, togetherSince: Long?) = repository.saveSetup(partnerNickname, ownName, partnerColor, togetherSince)
}

class SendMessage(private val repository: RucolaRepository) {
    suspend operator fun invoke(type: MessageType, body: String, mediaReference: String? = null) = repository.sendMessage(type, body, mediaReference)
}