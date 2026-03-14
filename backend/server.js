const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getCalendarClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.calendar({ version: 'v3', auth });
}

const CALENDAR_TOOLS = [
  {
    name: 'list_events',
    description: 'Googleカレンダーから指定期間の予定一覧を取得する。',
    input_schema: {
      type: 'object',
      properties: {
        time_min: { type: 'string', description: 'ISO8601形式の開始日時' },
        time_max: { type: 'string', description: 'ISO8601形式の終了日時' },
      },
      required: ['time_min', 'time_max'],
    },
  },
  {
    name: 'create_event',
    description: 'Googleカレンダーに予定を追加する。繰り返しも対応。ユーザー確認後に呼び出す。',
    input_schema: {
      type: 'object',
      properties: {
        summary:     { type: 'string', description: '予定のタイトル' },
        start:       { type: 'string', description: '開始日時 ISO8601形式' },
        end:         { type: 'string', description: '終了日時 ISO8601形式' },
        location:    { type: 'string', description: '場所（任意）' },
        description: { type: 'string', description: 'メモ（任意）' },
        attendees:   { type: 'array', items: { type: 'string' }, description: '参加者メール一覧（任意）' },
        recurrence:  { type: 'string', description: '繰り返しルール。例: RRULE:FREQ=WEEKLY;BYDAY=MO（毎週月曜）、RRULE:FREQ=DAILY（毎日）、RRULE:FREQ=MONTHLY（毎月）、RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR（毎週月水金）、RRULE:FREQ=WEEKLY;COUNT=10（10回繰り返し）、RRULE:FREQ=WEEKLY;UNTIL=20261231T000000Z（終了日指定）' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'update_event',
    description: 'Googleカレンダーの既存の予定を変更する。ユーザー確認後に呼び出す。',
    input_schema: {
      type: 'object',
      properties: {
        event_id:    { type: 'string', description: '必ずlist_eventsの結果の(event_id=xxx)から取得した正確なID。絶対に推測や作成をしないこと' },
        summary:     { type: 'string', description: '新しいタイトル（任意）' },
        start:       { type: 'string', description: '新しい開始日時 ISO8601形式（任意）' },
        end:         { type: 'string', description: '新しい終了日時 ISO8601形式（任意）' },
        location:    { type: 'string', description: '新しい場所（任意）' },
        description: { type: 'string', description: '新しいメモ（任意）' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_event',
    description: 'Googleカレンダーの予定を削除する。ユーザー確認後に呼び出す。',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: '必ずlist_eventsの結果の(event_id=xxx)から取得した正確なID。絶対に推測や作成をしないこと' },
        summary:  { type: 'string', description: '確認用の予定タイトル' },
      },
      required: ['event_id', 'summary'],
    },
  },
];

function getSystemPrompt() {
  const now = new Date().toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });
  return `あなたは優秀なAI秘書です。ユーザーのGoogleカレンダー管理をサポートします。

今日の日付：${now}
必ずこの日付を基準に「明日」「来週」などを計算すること。年は2026年です。

## 行動指針

1. 予定の登録依頼を受けたとき
   - まず list_events で対象日時の予定を取得して重複を確認する
   - 予定内容をユーザーに確認する（create_eventはまだ呼ばない）
   - ユーザーが確認したら create_event を呼ぶ

2. 繰り返し予定の登録依頼を受けたとき
   - 「毎週〇曜日」「毎日」「毎月」などを適切なRRULEに変換する
   - 終了日や回数が指定されていれば UNTIL または COUNT を使う
   - 確認フォーマットに「繰り返し：毎週〇曜日」などを含める

3. 予定の変更依頼を受けたとき
   - まず list_events で対象の予定を検索してevent_idを取得する
   - 変更内容をユーザーに確認する（update_eventはまだ呼ばない）
   - ユーザーが確認したら update_event を呼ぶ

4. 予定の削除依頼を受けたとき
   - まず list_events で対象の予定を検索してevent_idを取得する
   - 「本当に削除しますか？」と必ず確認する（delete_eventはまだ呼ばない）
   - ユーザーが確認したら delete_event を呼ぶ

5. 重複が見つかったとき
   - 既存の予定名と時間をユーザーに知らせ代替案を提案する

6. 予定確認の依頼を受けたとき
   - list_events で取得し、わかりやすく一覧表示する

## レスポンスのルール
- 日本語で丁寧に話す
- 必ずユーザーに確認してから実行する
- 登録確認フォーマット：
  📅 登録内容の確認
  ・タイトル：〇〇
  ・日時：〇月〇日（曜日）HH:MM〜HH:MM
  ・繰り返し：毎週〇曜日（繰り返しの場合のみ）
  この内容で登録しますか？
- 変更確認フォーマット：
  ✏️ 変更内容の確認
  ・タイトル：〇〇
  ・変更前：〇月〇日 HH:MM〜HH:MM
  ・変更後：〇月〇日 HH:MM〜HH:MM
  この内容で変更しますか？
- 削除確認フォーマット：
  🗑️ 削除の確認
  ・タイトル：〇〇
  ・日時：〇月〇日 HH:MM〜HH:MM
  本当に削除しますか？`;
}

async function executeCalendarTool(toolName, toolInput, accessToken) {
  const calendar = getCalendarClient(accessToken);

  if (toolName === 'list_events') {
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: toolInput.time_min,
      timeMax: toolInput.time_max,
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: 'Asia/Tokyo',
    });
    const events = res.data.items || [];
    if (events.length === 0) return '指定期間に予定はありません。';
    return events.map(e => {
      const start = e.start.dateTime || e.start.date;
      const end   = e.end.dateTime   || e.end.date;
      return `・${e.summary}　${start} 〜 ${end}　(event_id=${e.id})`;
    }).join('\n');
  }

  if (toolName === 'create_event') {
    const event = {
      summary:     toolInput.summary,
      location:    toolInput.location,
      description: toolInput.description,
      start: { dateTime: toolInput.start, timeZone: 'Asia/Tokyo' },
      end:   { dateTime: toolInput.end,   timeZone: 'Asia/Tokyo' },
    };
    if (toolInput.recurrence) {
      event.recurrence = [toolInput.recurrence];
    }
    if (toolInput.attendees?.length) {
      event.attendees = toolInput.attendees.map(email => ({ email }));
    }
    const res = await calendar.events.insert({ calendarId: 'primary', resource: event });
    return `登録完了！イベントID: ${res.data.id}\nカレンダーリンク: ${res.data.htmlLink}`;
  }

  if (toolName === 'update_event') {
    const existing = await calendar.events.get({
      calendarId: 'primary',
      eventId: toolInput.event_id,
    });
    const event = existing.data;
    if (toolInput.summary)     event.summary     = toolInput.summary;
    if (toolInput.location)    event.location    = toolInput.location;
    if (toolInput.description) event.description = toolInput.description;
    if (toolInput.start) event.start = { dateTime: toolInput.start, timeZone: 'Asia/Tokyo' };
    if (toolInput.end)   event.end   = { dateTime: toolInput.end,   timeZone: 'Asia/Tokyo' };
    await calendar.events.update({
      calendarId: 'primary',
      eventId: toolInput.event_id,
      resource: event,
    });
    return `変更完了！「${event.summary}」を更新しました。`;
  }

  if (toolName === 'delete_event') {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: toolInput.event_id,
    });
    return `削除完了！「${toolInput.summary}」を削除しました。`;
  }

  return 'Unknown tool';
}

app.post('/api/chat', async (req, res) => {
  const { messages, accessToken } = req.body;
  if (!accessToken) return res.status(401).json({ error: 'Google認証が必要です。' });
  let currentMessages = [...messages];
  try {
    while (true) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: getSystemPrompt(),
        tools: CALENDAR_TOOLS,
        messages: currentMessages,
      });
      if (response.stop_reason === 'end_turn') {
        const text = response.content.find(b => b.type === 'text')?.text || '';
        return res.json({ reply: text });
      }
      if (response.stop_reason === 'tool_use') {
        currentMessages.push({ role: 'assistant', content: response.content });
        const toolResults = await Promise.all(
          response.content
            .filter(b => b.type === 'tool_use')
            .map(async (toolUse) => {
              console.log(`[Tool] ${toolUse.name}`, toolUse.input);
              let result;
              try {
                result = await executeCalendarTool(toolUse.name, toolUse.input, accessToken);
              } catch (err) {
                result = `エラー: ${err.message}`;
              }
              console.log(`[Tool Result] ${result.slice(0, 100)}`);
              return { type: 'tool_result', tool_use_id: toolUse.id, content: result };
            })
        );
        currentMessages.push({ role: 'user', content: toolResults });
        continue;
      }
      break;
    }
    res.json({ reply: '処理が完了しました。' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `サーバーエラー: ${err.message}` });
  }
});

app.get('/auth/google', (req, res) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/auth/google/callback'
  );
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent',
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/auth/google/callback'
  );
  try {
    const { tokens } = await oauth2Client.getToken(code);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}?access_token=${tokens.access_token}&refresh_token=${tokens.refresh_token || ''}`);
  } catch (err) {
    res.status(500).send(`認証エラー: ${err.message}`);
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`AI秘書サーバー起動 → http://localhost:${PORT}`));
