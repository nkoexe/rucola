package com.rucola.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.rucola.app.data.repository
import com.rucola.app.domain.*
import kotlinx.coroutines.launch

private val Leaf = Color(0xFFDDEED0)
private val Butter = Color(0xFFF6F3D5)
private val Moss = Color(0xFF406344)
private val Ink = Color(0xFF263B2A)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { RucolaApp(repository(applicationContext)) }
    }
}

@Composable
fun RucolaApp(repository: com.rucola.app.data.RucolaRepository) {
    val relationship by repository.relationship.collectAsState(null)
    val messages by repository.messages().collectAsState(emptyList())
    val scope = rememberCoroutineScope()
    var composer by remember { mutableStateOf(false) }
    var setupNickname by remember { mutableStateOf("") }
    val pager = rememberPagerState { 2 }

    MaterialTheme(colorScheme = lightColorScheme(background = Leaf, surface = Butter, primary = Moss, onBackground = Ink, onSurface = Ink)) {
        if (relationship == null) {
            SetupScreen(setupNickname) { nickname, avatar, date -> scope.launch { repository.saveSetup(nickname, avatar, date) } }
        } else if (composer) {
            ComposerScreen(onBack = { composer = false }) { type, body -> scope.launch { repository.sendMessage(type, body); composer = false } }
        } else {
            HorizontalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
                if (page == 0) HomeScreen(relationship!!, messages, onCompose = { composer = true })
                else HistoryScreen(messages)
            }
        }
    }
}

@Composable
private fun SetupScreen(value: String, onSave: (String, String, Long?) -> Unit) {
    var nickname by remember { mutableStateOf(value) }
    var avatar by remember { mutableStateOf("🌱") }
    var dateEnabled by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text("rucola", fontSize = 52.sp, fontWeight = FontWeight.Bold, color = Moss, modifier = Modifier.rotate(-3f))
        Text("a tiny mailbox for two", color = Ink.copy(alpha = .7f), fontSize = 18.sp)
        Spacer(Modifier.height(38.dp))
        Text("How should we call them?", fontSize = 25.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(nickname, { nickname = it }, label = { Text("Partner nickname") }, singleLine = true, shape = RoundedCornerShape(22.dp))
        Spacer(Modifier.height(22.dp))
        Text("Pick their little avatar", fontWeight = FontWeight.Bold)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(12.dp)) { listOf("🌱", "🍓", "🌻", "🥝").forEach { choice -> FilterChip(selected = avatar == choice, onClick = { avatar = choice }, label = { Text(choice, fontSize = 24.sp) }) } }
        Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(dateEnabled, { dateEnabled = it }); Text(if (dateEnabled) "Together since today" else "shh.. not yet") }
        Spacer(Modifier.height(25.dp))
        Button(onClick = { onSave(nickname.trim().ifEmpty { "my love" }, avatar, if (dateEnabled) System.currentTimeMillis() else null) }, shape = RoundedCornerShape(20.dp), enabled = nickname.isNotBlank()) { Text("Open our mailbox") }
    }
}

@Composable
private fun HomeScreen(relationship: Relationship, messages: List<Message>, onCompose: () -> Unit) {
    val partner = messages.firstOrNull { it.participant == Participant.PARTNER && it.isActive }
    Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.height(18.dp)); Text("♡ ${relationship.partnerNickname}", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = Moss)
        Spacer(Modifier.height(38.dp)); MessageBubble(partner, "Nothing waiting yet")
        Spacer(Modifier.weight(1f)); Text("swipe for our little history", color = Ink.copy(alpha = .6f)); Spacer(Modifier.height(14.dp))
        FloatingActionButton(onClick = onCompose, containerColor = Color(0xFFF0C95C), contentColor = Ink) { Text("+", fontSize = 28.sp) }
        Spacer(Modifier.height(22.dp))
    }
}

@Composable
private fun MessageBubble(message: Message?, empty: String) {
    Surface(color = Butter, shape = RoundedCornerShape(36.dp), shadowElevation = 3.dp, modifier = Modifier.fillMaxWidth().heightIn(min = 210.dp)) {
        Box(Modifier.padding(28.dp), contentAlignment = Alignment.Center) { Text(message?.body ?: empty, fontSize = 29.sp, fontWeight = FontWeight.Medium) }
    }
}

@Composable
private fun ComposerScreen(onBack: () -> Unit, onSend: (MessageType, String) -> Unit) {
    var type by remember { mutableStateOf(MessageType.TEXT) }; var body by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(24.dp)) {
        TextButton(onClick = onBack) { Text("← back") }; Text("Leave a little something", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = Moss)
        Row(Modifier.padding(vertical = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { MessageType.values().forEach { option -> FilterChip(type == option, { type = option }, label = { Text(option.name.lowercase().replace('_', ' ')) }) } }
        if (type == MessageType.TEXT || type == MessageType.EMOJI) OutlinedTextField(body, { body = it }, label = { Text(if (type == MessageType.EMOJI) "Emoji" else "Your message") }, modifier = Modifier.fillMaxWidth(), minLines = 3, shape = RoundedCornerShape(22.dp))
        else Surface(color = Color(0xFFF0C95C), shape = RoundedCornerShape(28.dp), modifier = Modifier.fillMaxWidth().height(180.dp)) { Box(contentAlignment = Alignment.Center) { Text(if (type == MessageType.DRAWING) "✏ drawing space soon" else "📷 photo / video soon", fontSize = 23.sp) } }
        Spacer(Modifier.weight(1f)); Button({ onSend(type, body.ifBlank { if (type == MessageType.EMOJI) "🥺" else "[${type.name.lowercase()}]" }) }, enabled = type != MessageType.TEXT || body.isNotBlank(), modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp)) { Text("Send it") }
    }
}

@Composable
private fun HistoryScreen(messages: List<Message>) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text("Our little history", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = Moss); Text("everything stays here", color = Ink.copy(alpha = .65f)); Spacer(Modifier.height(24.dp))
        messages.forEach { message -> Surface(color = if (message.participant == Participant.ME) Color(0xFFF0C95C) else Butter, shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) { Column(Modifier.padding(18.dp)) { Text(if (message.participant == Participant.ME) "You" else "${message.participant}", fontWeight = FontWeight.Bold); Text(message.body, fontSize = 20.sp) } } }
    }
}