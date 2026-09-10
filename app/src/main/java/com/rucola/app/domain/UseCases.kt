package com.rucola.app.domain

import com.rucola.app.data.RucolaRepository

class SaveSetup(private val repository: RucolaRepository) {
    suspend operator fun invoke(nickname: String, avatar: String, togetherSince: Long?) = repository.saveSetup(nickname, avatar, togetherSince)
}

class SendMessage(private val repository: RucolaRepository) {
    suspend operator fun invoke(type: MessageType, body: String) = repository.sendMessage(type, body)
}