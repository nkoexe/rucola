import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { getRepository } from '../../data/repository';
import type { Message, Relationship } from '../../domain/models';
import { GetMessages } from '../../domain/useCases';
import { MessageMedia } from '../../components/MessageMedia';

type Props = { relationship: Relationship; repositoryPromise: ReturnType<typeof getRepository>; onBack: () => void };

function startOfDay(timestamp: number) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function CalendarScreen({ relationship, repositoryPromise, onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState(() => {
    const date = new Date();
    return new Date(date.getFullYear(), date.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;
    setError(null);
    void repositoryPromise
      .then((repository) => new GetMessages(repository).execute())
      .then((value) => {
        if (mounted) setMessages(value.filter((message) => message.participant === 'ME' || !message.isActive));
      })
      .catch((cause) => {
        if (mounted) setError(cause instanceof Error ? cause.message : 'Could not load calendar history.');
      });
    return () => { mounted = false; };
  }, [repositoryPromise]);

  const messagesByDay = useMemo(() => {
    const map = new Map<number, Message[]>();
    for (const message of messages) {
      const day = startOfDay(message.createdAt);
      map.set(day, [...(map.get(day) ?? []), message]);
    }
    return map;
  }, [messages]);

  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const mondayOffset = (firstWeekday + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((mondayOffset + daysInMonth) / 7) * 7 }, (_, index) => {
    const day = index - mondayOffset + 1;
    return day >= 1 && day <= daysInMonth ? day : null;
  });

  const selectedTimestamp = selectedDay === null ? null : startOfDay(new Date(year, monthIndex, selectedDay).getTime());
  const selectedMessages = selectedTimestamp === null ? [] : messagesByDay.get(selectedTimestamp) ?? [];
  const today = startOfDay(Date.now());

  return (
    <View style={styles.container}>
      <Pressable onPress={onBack}><Text style={styles.back}>‹ back</Text></Pressable>
      <Text style={styles.title}>calendar</Text>
      <Text style={styles.subtitle}>{relationship.partnerNickname}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.monthHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => { setMonth(new Date(year, monthIndex - 1, 1)); setSelectedDay(null); }}><Text style={styles.nav}>‹</Text></Pressable>
        <Text style={styles.monthTitle}>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => { setMonth(new Date(year, monthIndex + 1, 1)); setSelectedDay(null); }}><Text style={styles.nav}>›</Text></Pressable>
      </View>

      <View style={styles.weekRow}>{['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((day) => <Text key={day} style={styles.weekday}>{day}</Text>)}</View>
      <View style={styles.grid}>
        {cells.map((day, index) => {
          if (day === null) return <View key={`empty-${index}`} style={styles.cell} />;
          const timestamp = startOfDay(new Date(year, monthIndex, day).getTime());
          const hasMessages = messagesByDay.has(timestamp);
          const selected = selectedDay === day;
          const isToday = timestamp === today;
          return (
            <Pressable key={day} onPress={() => setSelectedDay(day)} style={[styles.cell, selected && styles.selectedCell, isToday && styles.todayCell]}>
              <Text style={[styles.day, selected && styles.selectedText]}>{day}</Text>
              {hasMessages && <View style={styles.dot} />}
            </Pressable>
          );
        })}
      </View>

      <ScrollView style={styles.details} contentContainerStyle={styles.detailsContent}>
        {selectedDay === null ? <Text style={styles.muted}>select a date to see messages</Text> : selectedMessages.length === 0 ? <Text style={styles.muted}>no messages on {new Date(year, monthIndex, selectedDay).toLocaleDateString()}</Text> : selectedMessages.map((message) => (
          <View key={message.id} style={styles.message}>
            <Text style={styles.sender}>{message.participant === 'ME' ? 'you' : relationship.partnerNickname}</Text>
            {message.type === 'PHOTO_VIDEO' ? <MessageMedia message={message} /> : <Text>{message.body || message.type.toLowerCase()}</Text>}
            {message.body && message.type === 'PHOTO_VIDEO' ? <Text style={styles.caption}>{message.body}</Text> : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 22, backgroundColor: '#F3F6E9' },
  back: { fontSize: 17, textDecorationLine: 'underline', marginBottom: 20 },
  title: { fontSize: 32, fontWeight: '800' },
  subtitle: { marginTop: 4, opacity: 0.6 },
  error: { color: '#9B2C2C', marginTop: 12 },
  monthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 30 },
  monthTitle: { fontSize: 20, fontWeight: '700' },
  nav: { fontSize: 32, paddingHorizontal: 14 },
  weekRow: { flexDirection: 'row', marginTop: 12 },
  weekday: { flex: 1, textAlign: 'center', fontWeight: '700', opacity: 0.5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  cell: { width: '14.2857%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  todayCell: { borderWidth: 1 },
  selectedCell: { backgroundColor: '#1D2A1B' },
  day: { fontSize: 16 },
  selectedText: { color: '#F3F6E9', fontWeight: '700' },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#8FC56A', marginTop: 3 },
  details: { flex: 1, marginTop: 20 },
  detailsContent: { gap: 10, paddingBottom: 24 },
  muted: { opacity: 0.55 },
  message: { backgroundColor: '#E4F0D9', borderRadius: 14, padding: 14, gap: 8 },
  sender: { fontWeight: '700', opacity: 0.6 },
  caption: { fontSize: 15 },
});
