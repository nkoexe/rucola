package com.rucola.app

import androidx.compose.runtime.*
import androidx.compose.ui.test.*

@Composable
fun SetupPreview() {
    var nickname by remember { mutableStateOf("") }
    androidx.compose.material3.OutlinedTextField(nickname, { nickname = it }, label = { androidx.compose.material3.Text("Partner nickname") })
    androidx.compose.material3.Button({}) { androidx.compose.material3.Text("Open our mailbox") }
}