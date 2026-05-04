const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const https = require('https');

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const DAVID_USER_ID = process.env.DAVID_USER_ID || '';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
const CALENDAR_ID = process.env.CALENDAR_ID || '';

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/calendar',
    ],
  });
}

function getSheetClient() {
  return google.sheets({ version: 'v4', auth: getGoogleAuth() });
}

function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: getGoogleAuth() });
}

async function loadContacts() {
  try {
    const sheets = getSheetClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: '工作表1!A2:E1000',
    });
    const rows = res.data.values || [];
    const contacts = {};
    for (const row of rows) {
      if (row[0]) {
        contacts[row[0]] = {
          name: row[1] || '',
          relation: row[2] || '',
          note: row[3] || '',
          joinTime: row[4] || '',
        };
      }
    }
    console.log(`✅ 載入 ${Object.keys(contacts).length} 筆聯絡人`);
    return contacts;
  } catch (e) {
    console.error('載入聯絡人失敗:', e.message);
    return {};
  }
}

async function saveContact(userId, name, relation) {
  try {
    const sheets = getSheetClient();
    const joinTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: '工作表1!A:E',
      valueInputOption: 'RAW',
      requestBody: { values: [[userId, name, relation, '', joinTime]] },
    });
  } catch (e) {
    console.error('儲存聯絡人失敗:', e.message);
  }
}

async function updateNote(userId, note) {
  try {
    const sheets = getSheetClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: '工作表1!A2:E1000',
    });
    const rows = res.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === userId) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `工作表1!D${i + 2}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[note]] },
        });
        return true;
      }
    }
    return false;
  } catch (e) {
    console.error('更新備註失敗:', e.message);
    return false;
  }
}

function extractTimeStr(input) {
  const match = input.match(/(今天|明天|後天|下週[一二三四五六日]|這週[一二三四五六日]|\d+月\d+日?)?[\s]*(上午|下午|早上|晚上)?[\s]*(\d{1,2})[點:時](\d{0,2})?/);
  if (match) return match[0].trim();
  if (input.includes('今天') || input.includes('明天') || input.includes('後天')) {
    return input.match(/(今天|明天|後天)/)[0];
  }
  return input;
}

function parseEventTime(timeStr) {
  const now = new Date();
  const taipei = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  let date = new Date(taipei);
  let hasTime = false;

  if (timeStr.includes('明天') || timeStr.includes('明日')) {
    date.setDate(date.getDate() + 1);
  } else if (timeStr.includes('後天')) {
    date.setDate(date.getDate() + 2);
  }

  const timeMatch = timeStr.match(/(上午|下午|早上|晚上)?(\d{1,2})[點:時](\d{0,2})?/);
  if (timeMatch) {
    hasTime = true;
    let hour = parseInt(timeMatch[2]);
    const minute = timeMatch[3] ? parseInt(timeMatch[3]) : 0;
    const period = timeMatch[1];
    if ((period === '下午' || period === '晚上') && hour < 12) hour += 12;
    if (period === '上午' && hour === 12) hour = 0;
    date.setHours(hour, minute, 0, 0);
  }

  return { date, hasTime };
}

async function addCalendarEvent(title, timeStr, duration = 60) {
  try {
    const calendar = getCalendarClient();
    const { date, hasTime } = parseEventTime(timeStr);
    let event;
    if (hasTime) {
      const endDate = new Date(date.getTime() + duration * 60000);
      event = {
        summary: title,
        start: { dateTime: date.toISOString(), timeZone: 'Asia/Taipei' },
        end: { dateTime: endDate.toISOString(), timeZone: 'Asia/Taipei' },
      };
    } else {
      const dateStr = date.toISOString().split('T')[0];
      event = {
        summary: title,
        start: { date: dateStr },
        end: { date: dateStr },
      };
    }
    const res = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: event });
    return { success: true, event: res.data };
  } catch (e) {
    console.error('新增行程失敗:', e.message);
    return { success: false, error: e.message };
  }
}

async function getCalendarEvents(dateStr) {
  try {
    const calendar = getCalendarClient();
    const taipei = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    let targetDate = new Date(taipei);
    if (dateStr === '明天') targetDate.setDate(targetDate.getDate() + 1);
    else if (dateStr === '後天') targetDate.setDate(targetDate.getDate() + 2);
    else if (dateStr === '本週') {
      const day = targetDate.getDay();
      targetDate.setDate(targetDate.getDate() - day + 1);
    }
    targetDate.setHours(0, 0, 0, 0);
    const endDate = new Date(targetDate);
    if (dateStr === '本週') endDate.setDate(endDate.getDate() + 7);
    else endDate.setDate(endDate.getDate() + 1);
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: targetDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: 'Asia/Taipei',
    });
    return res.data.items || [];
  } catch (e) {
    console.error('查詢行程失敗:', e.message);
    return [];
  }
}

function formatEvents(events, label) {
  if (events.length === 0) return `📅 ${label}沒有行程`;
  const list = events.map(e => {
    const start = e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })
      : '全天';
    return `• ${start} ${e.summary}`;
  }).join('\n');
  return `📅 ${label}行程\n\n${list}`;
}

async function downloadImageAsBase64(messageId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api-data.line.me',
      path: `/v2/bot/message/${messageId}/content`,
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    };
    https.get(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const groupMessages = {};
const pendingTasks = [];
const waitingForName = {};
let contacts = {};
const pendingImages = {};
const lastDraft = {};
const pendingReply = {};
const pendingBooking = {};
const waitingBookingConfirm = {};

loadContacts().then(data => { contacts = data; });

const BRAND_PROMPTS = {
  df: `你是大衛的 AI 助理，請根據提供的內容，產出【DF-OFFROAD】越野吉普車品牌的 IG 文章草稿。風格：賣態度、賣夢想、讓人想加入這個圈子。請包含內文和 3-5 個 hashtag。`,
  david: `你是大衛的 AI 助理，請根據提供的內容，產出【個人品牌 @davidcheng_lifestyle】的 IG 文章草稿。風格：像跟朋友說真心話，真實不裝。請包含內文和 3-5 個 hashtag。`,
  viebelle: `你是大衛的 AI 助理，請根據提供的內容，產出【Viebelle與蜜】的 IG 文章草稿。風格：看了就想吃，注重健康生活品質。請包含內文和 3-5 個 hashtag。`,
  charity: `你是大衛的 AI 助理，請根據提供的內容，產出【聖朝百年慈善】的 IG 文章草稿。風格：召集同伴，一起把好事傳承下去。請包含內文和 3-5 個 hashtag。`,
  all: `你是大衛的 AI 助理。請根據提供的內容，產出四個品牌的 IG 文章草稿：
1. 【DF-OFFROAD】
2. 【個人品牌 @davidcheng_lifestyle】
3. 【Viebelle與蜜】
4. 【聖朝百年慈善】
請為每個品牌各產出一篇 IG 文章草稿，包含內文和 3-5 個 hashtag。`
};

const BRAND_MAP = {
  'df': 'df', 'df-offroad': 'df', '越野': 'df',
  'david': 'david', '個人': 'david', '個人品牌': 'david',
  'viebelle': 'viebelle', 'viebelle與蜜': 'viebelle', '麵包': 'viebelle',
  '聖朝': 'charity', '慈善': 'charity', 'charity': 'charity',
  '全部': 'all', 'all': 'all'
};

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.json({ status: 'ok' });
  const events = req.body.events;

  for (const event of events) {
    const sourceType = event.source.type;
    const userId = event.source.userId;
    const isGroup = sourceType === 'group' || sourceType === 'room';
    const isDavid = userId === DAVID_USER_ID;

    if (event.type === 'message' && event.message.type === 'image' && isDavid) {
      pendingImages[userId] = { messageId: event.message.id, time: Date.now() };
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '📸 圖片收到！請傳指令，例如：\n寫文案 df 幫我賣這個產品' }],
      });
      continue;
    }

    if (event.type !== 'message' || event.message.type !== 'text') continue;
    const text = event.message.text.trim();

    // ===== 群組模式 =====
    if (isGroup) {
      const groupId = event.source.groupId || event.source.roomId;
      if (!groupMessages[groupId]) groupMessages[groupId] = [];
      groupMessages[groupId].push({
        time: new Date().toLocaleTimeString('zh-TW'),
        sender: contacts[userId] ? contacts[userId].name : userId.slice(-6),
        text,
      });
      if (groupMessages[groupId].length > 100) groupMessages[groupId] = groupMessages[groupId].slice(-100);

      if (text.includes('@David摘要') || text.includes('@摘要')) {
        const msgs = groupMessages[groupId];
        const msgText = msgs.map(m => `${m.time} ${m.sender}: ${m.text}`).join('\n');
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 800,
          messages: [{ role: 'user', content: `請整理以下群組訊息的重點，條列式：\n\n${msgText}` }],
        });
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '📋 群組摘要\n\n' + response.content[0].text }],
        });

      } else if (text.includes('@David取消')) {
        const content = text.replace(/@David取消\s*/, '').trim();
        const senderName = contacts[userId] ? contacts[userId].name : userId.slice(-6);
        const reasonMatch = content.match(/原因[：:]\s*(.+)/);
        const reason = reasonMatch ? reasonMatch[1].trim() : '未說明';
        const eventInfo = content.replace(/原因[：:].+/, '').trim();
        const cancelId = Date.now().toString();

        await client.pushMessage({
          to: DAVID_USER_ID,
          messages: [{
            type: 'text',
            text: `🚨 取消申請！\n\n👤 ${senderName} 申請取消行程\n📌 ${eventInfo}\n💬 原因：${reason}\n\n請確認是否取消？`,
            quickReply: {
              items: [
                { type: 'action', action: { type: 'message', label: '✅ 確認取消', text: `群組確認取消_${cancelId}_${eventInfo}_${groupId}_${userId}` } },
                { type: 'action', action: { type: 'message', label: '❌ 不取消', text: `群組拒絕取消_${cancelId}_${groupId}_${userId}_${senderName}` } },
              ],
            },
          }],
        });

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `✅ 已通知大衛！\n\n申請取消：${eventInfo}\n原因：${reason}\n\n等待大衛確認中...` }],
        });

      } else if (text.includes('@David留言')) {
        const content = text.replace(/@David留言\s*/, '').trim();
        const senderName = contacts[userId] ? contacts[userId].name : userId.slice(-6);

        await client.pushMessage({
          to: DAVID_USER_ID,
          messages: [{
            type: 'text',
            text: `💬 群組留言！\n\n👤 ${senderName} 在群組留言：\n\n${content}`,
            quickReply: {
              items: [
                { type: 'action', action: { type: 'message', label: '↩️ 回覆他', text: `回覆 ${senderName} ` } },
                { type: 'action', action: { type: 'message', label: '👍 已讀', text: '已讀留言' } },
              ],
            },
          }],
        });

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `✅ 已轉達給大衛！他會盡快回覆。` }],
        });
      }

    // ===== 大衛模式 =====
    } else if (isDavid) {

      // 群組取消確認
      if (text.startsWith('群組確認取消_')) {
        const parts = text.split('_');
        const eventInfo = parts[2];
        const groupId = parts[3];

        try {
          const calendar = getCalendarClient();
          const taipei = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
          taipei.setHours(0, 0, 0, 0);
          const endDate = new Date(taipei);
          endDate.setDate(endDate.getDate() + 30);
          const res = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: taipei.toISOString(),
            timeMax: endDate.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            q: eventInfo,
          });
          const evts = res.data.items || [];
          if (evts.length > 0) {
            await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: evts[0].id });
          }
        } catch (e) {
          console.error('刪除行程失敗:', e.message);
        }

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `✅ 已確認取消！行事曆已更新。` }],
        });

        await client.pushMessage({
          to: groupId,
          messages: [{ type: 'text', text: `✅ 大衛已確認取消：${eventInfo}` }],
        });

      } else if (text.startsWith('群組拒絕取消_')) {
        const parts = text.split('_');
        const groupId = parts[2];
        const senderName = parts[4];

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `✅ 已拒絕取消申請。` }],
        });

        await client.pushMessage({
          to: groupId,
          messages: [{ type: 'text', text: `❌ 大衛確認保留此行程，${senderName} 的取消申請不通過。` }],
        });

      } else if (text === '已讀留言') {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `✅ 已讀取。` }],
        });

      } else if (text.startsWith('確認預約_') || text.startsWith('拒絕預約_')) {
        const bookingId = text.split('_')[1];
        const booking = waitingBookingConfirm[bookingId];
        if (!booking) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ 找不到此預約，可能已過期。' }],
          });
        } else if (text.startsWith('確認預約_')) {
          const result = await addCalendarEvent(`${booking.name}｜${booking.title}`, booking.timeStr);
          delete waitingBookingConfirm[bookingId];
          if (result.success) {
            const { date, hasTime } = parseEventTime(booking.timeStr);
            const timeDisplay = hasTime
              ? date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : date.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });
            await client.replyMessage({
              replyToken: event.replyToken,
              messages: [{ type: 'text', text: `✅ 已確認並寫入行事曆！\n\n📅 ${timeDisplay}\n👤 ${booking.name}\n📌 ${booking.title}` }],
            });
            await client.pushMessage({
              to: booking.userId,
              messages: [{ type: 'text', text: `✅ 您好，${booking.name}！\n\n大衛已確認您的預約：\n📅 ${timeDisplay}\n📌 ${booking.title}\n\n期待與您會面！` }],
            });
          }
        } else {
          delete waitingBookingConfirm[bookingId];
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `✅ 已拒絕 ${booking.name} 的預約。` }],
          });
          await client.pushMessage({
            to: booking.userId,
            messages: [{ type: 'text', text: `您好，${booking.name}！\n\n很抱歉，大衛目前無法安排您的預約，請稍後再試或換個時間。謝謝！` }],
          });
        }

      } else if (text.startsWith('新增行程 ') || text.startsWith('新增行程：')) {
        const input = text.replace(/^新增行程[： ]/, '').trim();
        const match = input.match(/^(.+?)\s+(.+)$/);
        let timeStr, title;
        if (match && match[2]) { timeStr = match[1]; title = match[2]; }
        else { timeStr = '今天'; title = input; }
        const result = await addCalendarEvent(title, timeStr);
        if (result.success) {
          const { date, hasTime } = parseEventTime(timeStr);
          const timeDisplay = hasTime
            ? date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : date.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `✅ 已新增行程！\n\n📅 ${timeDisplay}\n📌 ${title}` }],
          });
        } else {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `❌ 新增失敗，請再試一次。` }],
          });
        }

      } else if (text.startsWith('取消行程 ') || text.startsWith('取消行程：')) {
        const keyword = text.replace(/^取消行程[： ]/, '').trim();
        try {
          const calendar = getCalendarClient();
          const taipei = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
          taipei.setHours(0, 0, 0, 0);
          const endDate = new Date(taipei);
          endDate.setDate(endDate.getDate() + 30);
          const res = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: taipei.toISOString(),
            timeMax: endDate.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            q: keyword,
          });
          const evts = res.data.items || [];
          if (evts.length === 0) {
            await client.replyMessage({
              replyToken: event.replyToken,
              messages: [{ type: 'text', text: `❌ 找不到「${keyword}」相關行程。` }],
            });
          } else if (evts.length === 1) {
            await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: evts[0].id });
            const start = evts[0].start.dateTime
              ? new Date(evts[0].start.dateTime).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : evts[0].start.date;
            await client.replyMessage({
              replyToken: event.replyToken,
              messages: [{ type: 'text', text: `✅ 已取消行程：\n\n📅 ${start}\n📌 ${evts[0].summary}` }],
            });
          } else {
            const list = evts.slice(0, 5).map((e, i) => {
              const start = e.start.dateTime
                ? new Date(e.start.dateTime).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : e.start.date;
              return `${i + 1}. ${start} ${e.summary}`;
            }).join('\n');
            await client.replyMessage({
              replyToken: event.replyToken,
              messages: [{ type: 'text', text: `找到多筆行程，請輸入更精確的關鍵字：\n\n${list}` }],
            });
          }
        } catch (error) {
          console.error('取消行程失敗:', error);
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `❌ 取消失敗，請再試一次。` }],
          });
        }

      } else if (text === '今天行程' || text === '今日行程') {
        const evts = await getCalendarEvents('今天');
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: formatEvents(evts, '今天') }] });

      } else if (text === '明天行程' || text === '明日行程') {
        const evts = await getCalendarEvents('明天');
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: formatEvents(evts, '明天') }] });

      } else if (text === '本週行程' || text === '這週行程') {
        const evts = await getCalendarEvents('本週');
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: formatEvents(evts, '本週') }] });

      } else if (text === '今天待辦' || text === '待辦清單') {
        if (pendingTasks.length === 0) {
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '✅ 今天目前沒有待辦事項。' }] });
        } else {
          const taskList = pendingTasks.map((t, i) => {
            const name = contacts[t.userId] ? contacts[t.userId].name : `陌生人(${t.userId.slice(-6)})`;
            return `${i + 1}. ${t.time} — ${name}：${t.text}`;
          }).join('\n');
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `📋 今天待辦（${pendingTasks.length}筆）\n\n${taskList}` }] });
        }

      } else if (text === '清空待辦') {
        pendingTasks.length = 0;
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '✅ 待辦清單已清空。' }] });

      } else if (text === '聯絡人清單') {
        if (Object.keys(contacts).length === 0) {
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '目前還沒有聯絡人記錄。' }] });
        } else {
          const list = Object.values(contacts).map(c => `${c.name}（${c.relation}）${c.note ? ' — ' + c.note : ''}`).join('\n');
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `📒 聯絡人清單\n\n${list}` }] });
        }

      } else if (text.startsWith('查 ')) {
        const searchName = text.replace(/^查 /, '').trim();
        const found = Object.entries(contacts).find(([, c]) => c.name.includes(searchName));
        if (!found) {
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `❌ 找不到「${searchName}」。` }] });
        } else {
          const [, c] = found;
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `👤 ${c.name}\n關係：${c.relation}\n備註：${c.note || '無'}\n加入時間：${c.joinTime}` }] });
        }

      } else if (text.startsWith('備註 ')) {
        const parts = text.replace(/^備註 /, '').trim().split(/\s+/);
        const searchName = parts[0];
        const note = parts.slice(1).join(' ');
        const found = Object.entries(contacts).find(([, c]) => c.name.includes(searchName));
        if (!found) {
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `❌ 找不到「${searchName}」。` }] });
        } else {
          const [foundUserId, c] = found;
          contacts[foundUserId].note = note;
          await updateNote(foundUserId, note);
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `✅ 已更新 ${c.name} 的備註：${note}` }] });
        }

      } else if (text.startsWith('回覆 ')) {
        const input = text.replace(/^回覆 /, '').trim();
        const spaceIdx = input.indexOf(' ');
        const searchName = spaceIdx > -1 ? input.slice(0, spaceIdx) : input;
        const instruction = spaceIdx > -1 ? input.slice(spaceIdx + 1) : '';
        const found = Object.entries(contacts).find(([, c]) => c.name.includes(searchName));
        if (!found) {
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `❌ 找不到「${searchName}」。` }] });
        } else {
          const [targetUserId, c] = found;
          try {
            await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '⏳ 正在幫你草擬回覆...' }] });
            const response = await anthropic.messages.create({
              model: 'claude-sonnet-4-5',
              max_tokens: 600,
              messages: [{ role: 'user', content: `你是大衛的秘書。大衛要回覆給 ${c.name}（關係：${c.relation}${c.note ? `，備註：${c.note}` : ''}）。\n\n回覆內容：${instruction}\n\n請幫大衛寫一段自然、得體的回覆訊息，口吻像大衛本人，不要太正式。` }],
            });
            const draft = response.content[0].text;
            pendingReply[userId] = { targetUserId, targetName: c.name, draft };
            await client.pushMessage({
              to: userId,
              messages: [{
                type: 'text',
                text: `📝 給 ${c.name} 的回覆草稿：\n\n${draft}\n\n請選擇：`,
                quickReply: {
                  items: [
                    { type: 'action', action: { type: 'message', label: '✅ 直接發送', text: '確認傳送' } },
                    { type: 'action', action: { type: 'message', label: '✨ 優化一下', text: '優化回覆' } },
                    { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } },
                  ],
                },
              }],
            });
          } catch (error) { console.error('Error:', error); }
        }

      } else if (text === '優化回覆') {
        const pending = pendingReply[userId];
        if (!pending) {
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '❌ 沒有待優化的回覆。' }] });
        } else {
          try {
            await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '⏳ 正在優化回覆...' }] });
            const response = await anthropic.messages.create({
              model: 'claude-sonnet-4-5',
              max_tokens: 600,
              messages: [{
                role: 'user',
                content: `以下是一段回覆草稿：\n\n${pending.draft}\n\n請幫我優化這段文字，讓它更自然流暢、更有溫度，但保留原本的意思。口吻要像大衛本人，不要太正式。直接給我優化後的文字。`
              }],
            });
            const optimized = response.content[0].text;
            pendingReply[userId].draft = optimized;
            await client.pushMessage({
              to: userId,
              messages: [{
                type: 'text',
                text: `✨ 優化後的回覆：\n\n${optimized}\n\n請選擇：`,
                quickReply: {
                  items: [
                    { type: 'action', action: { type: 'message', label: '✅ 直接發送', text: '確認傳送' } },
                    { type: 'action', action: { type: 'message', label: '✨ 再優化', text: '優化回覆' } },
                    { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } },
                  ],
                },
              }],
            });
          } catch (error) { console.error('Error:', error); }
        }

      } else if (text === '確認傳送') {
        const pending = pendingReply[userId];
        if (!pending) {
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '❌ 沒有待傳送的回覆。' }] });
        } else {
          try {
            await client.pushMessage({ to: pending.targetUserId, messages: [{ type: 'text', text: pending.draft }] });
            delete pendingReply[userId];
            await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `✅ 已成功傳送給 ${pending.targetName}！` }] });
          } catch (error) {
            await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `❌ 傳送失敗。` }] });
          }
        }

      } else if (text === '取消') {
        if (pendingReply[userId]) {
          delete pendingReply[userId];
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '✅ 已取消傳送。' }] });
        } else {
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '沒有待取消的動作。' }] });
        }

      } else if (text.startsWith('秘書：') || text.startsWith('秘書:')) {
        const content = text.replace(/^秘書[：:]/, '');
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 800,
          messages: [{ role: 'user', content: `你是大衛的秘書，請分析以下訊息並提供：\n1. 緊急程度（🔴馬上處理 / 🟡今天內 / 🟢可以等）\n2. 建議回覆文字\n3. 注意事項\n訊息內容：${content}` }],
        });
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: response.content[0].text }] });

      } else if (text.startsWith('寫文案')) {
        const input = text.replace(/^寫文案[： ]?/, '').trim();
        const parts = input.split(/\s+/);
        const brandRaw = parts[0].toLowerCase();
        const extraContent = parts.slice(1).join(' ');
        const brandKey = BRAND_MAP[brandRaw] || 'all';
        const prompt = BRAND_PROMPTS[brandKey];
        const imgData = pendingImages[userId];
        const hasImage = imgData && (Date.now() - imgData.time < 5 * 60 * 1000);
        try {
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '⏳ 正在幫你產出 IG 草稿，請稍等...' }] });
          let messages;
          if (hasImage) {
            const base64Image = await downloadImageAsBase64(imgData.messageId);
            delete pendingImages[userId];
            messages = [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
              { type: 'text', text: `${prompt}\n\n請根據這張照片${extraContent ? `和以下補充內容：${extraContent}` : ''}，產出 IG 文案。` }
            ]}];
          } else {
            messages = [{ role: 'user', content: `${prompt}\n\n今天的內容：${extraContent || input}` }];
          }
          const response = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1000, messages });
          lastDraft[userId] = response.content[0].text;
          await client.pushMessage({ to: userId, messages: [{ type: 'text', text: response.content[0].text }] });
        } catch (error) { console.error('Error:', error); }

      } else if (text.startsWith('修改')) {
        const instruction = text.replace(/^修改[： ]?/, '').trim();
        const previous = lastDraft[userId];
        if (!previous) {
          await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '❌ 還沒有暫存文案。' }] });
        } else {
          try {
            await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '⏳ 正在修改文案...' }] });
            const response = await anthropic.messages.create({
              model: 'claude-sonnet-4-5',
              max_tokens: 1000,
              messages: [{ role: 'user', content: `以下是原本的 IG 文案：\n\n${previous}\n\n請根據以下要求修改：${instruction || '整體優化'}\n\n請直接給我修改後的完整文案。` }],
            });
            lastDraft[userId] = response.content[0].text;
            await client.pushMessage({ to: userId, messages: [{ type: 'text', text: response.content[0].text }] });
          } catch (error) { console.error('Error:', error); }
        }

      } else if (text === '指令') {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `📋 大衛 AI 指令清單\n\n📅 行事曆\n新增行程 明天下午3點 工廠會議\n取消行程 工廠會議\n今天行程 / 明天行程 / 本週行程\n\n✍️ 文案\n寫文案 df [內容]\n寫文案 david [內容]\n寫文案 viebelle [內容]\n寫文案 聖朝 [內容]\n寫文案 全部 [內容]\n\n📸 照片文案\n先傳照片 → 再傳寫文案指令\n\n✏️ 修改文案\n修改 [修改要求]\n\n👤 聯絡人\n聯絡人清單\n查 [姓名]\n備註 [姓名] [備註內容]\n回覆 [姓名] [回覆內容]\n\n📋 待辦\n今天待辦 / 清空待辦\n\n🤖 秘書\n秘書：[訊息內容]\n\n👥 群組指令\n@David摘要\n@David取消 行程 原因：OOO\n@David留言 內容` }],
        });

      } else {
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `收到！請用指令操作，傳「指令」查看完整清單。` }] });
      }

    // ===== 陌生人模式 =====
    } else {

      if (pendingBooking[userId] && pendingBooking[userId].step === 'waiting_time') {
        const timeStr = extractTimeStr(text);
        pendingBooking[userId].timeStr = timeStr;
        pendingBooking[userId].step = 'waiting_title';
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `收到時間：${timeStr} ✅\n\n請問這次預約的事由是？\n例如：產品洽談、工廠參觀、合作討論` }],
        });

      } else if (pendingBooking[userId] && pendingBooking[userId].step === 'waiting_title') {
        const booking = pendingBooking[userId];
        const title = text;
        delete pendingBooking[userId];

        const bookingId = Date.now().toString();
        waitingBookingConfirm[bookingId] = {
          userId, name: booking.name, relation: booking.relation,
          timeStr: booking.timeStr, title,
        };

        const { date, hasTime } = parseEventTime(booking.timeStr);
        const timeDisplay = hasTime
          ? date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : date.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });

        await client.pushMessage({
          to: DAVID_USER_ID,
          messages: [{
            type: 'text',
            text: `📅 有人想預約！\n\n👤 ${booking.name}（${booking.relation}）\n🕐 ${timeDisplay}\n📌 ${title}\n\n請確認是否接受？`,
            quickReply: {
              items: [
                { type: 'action', action: { type: 'message', label: '✅ 確認預約', text: `確認預約_${bookingId}` } },
                { type: 'action', action: { type: 'message', label: '❌ 拒絕預約', text: `拒絕預約_${bookingId}` } },
              ],
            },
          }],
        });

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `✅ 預約申請已送出！\n\n📅 ${timeDisplay}\n📌 ${title}\n\n大衛確認後會通知您，請稍候！` }],
        });

      } else if (text === '預約') {
        const contact = contacts[userId];
        if (!contact) {
          waitingForName[userId] = true;
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `您好！請先告訴我您的姓名和關係，才能預約。\n\n📝 格式：姓名，關係\n例如：王小明，工廠客戶` }],
          });
        } else {
          pendingBooking[userId] = { name: contact.name, relation: contact.relation, step: 'waiting_time' };
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `您好，${contact.name}！\n\n📅 請問您想預約哪個時間？\n\n例如：\n• 明天下午3點\n• 下週一上午10點\n• 5月10日下午2點` }],
          });
        }

      } else if (waitingForName[userId]) {
        const parts = text.split(/[,，、\s]+/);
        const name = parts[0] || text;
        const relation = parts[1] || '未知';
        contacts[userId] = { name, relation };
        delete waitingForName[userId];
        await saveContact(userId, name, relation);
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `謝謝您，${name}！我已幫您登記，大衛會盡快回覆您。\n\n如需預約時間，請傳「預約」。`,
            quickReply: {
              items: [{ type: 'action', action: { type: 'message', label: '📅 預約時間', text: '預約' } }],
            },
          }],
        });
        if (DAVID_USER_ID) {
          await client.pushMessage({ to: DAVID_USER_ID, messages: [{ type: 'text', text: `📨 新聯絡人登記！\n\n姓名：${name}\n關係：${relation}` }] });
        }

      } else if (!contacts[userId]) {
        waitingForName[userId] = true;
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `您好！我是大衛的 AI 助理 🤖\n\n請問您的姓名是？以及您跟大衛是什麼關係？\n\n📝 格式：姓名，關係\n例如：王小明，工廠客戶` }],
        });

      } else {
        const name = contacts[userId].name;
        pendingTasks.push({ time: new Date().toLocaleTimeString('zh-TW'), userId, text });
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `您好，${name}！大衛目前很忙，我已幫您記錄訊息，他稍後會回覆您。\n\n如需預約時間，請傳「預約」。`,
            quickReply: {
              items: [{ type: 'action', action: { type: 'message', label: '📅 預約時間', text: '預約' } }],
            },
          }],
        });
        if (DAVID_USER_ID) {
          await client.pushMessage({ to: DAVID_USER_ID, messages: [{ type: 'text', text: `📨 有新訊息！\n\n${name}說：${text}` }] });
        }
      }
    }
  }
});

app.get('/', (req, res) => {
  res.send('David AI Bot is running! 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
