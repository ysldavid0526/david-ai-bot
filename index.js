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

// ===== Google Sheets =====
function getSheetClient() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
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
      requestBody: {
        values: [[userId, name, relation, '', joinTime]],
      },
    });
    console.log(`✅ 已儲存聯絡人：${name}`);
  } catch (e) {
    console.error('儲存聯絡人失敗:', e.message);
  }
}

// ===== 下載圖片為 base64 =====
async function downloadImageAsBase64(messageId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api-data.line.me',
      path: `/v2/bot/message/${messageId}/content`,
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    };
    https.get(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString('base64'));
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ===== 記憶體資料 =====
const groupMessages = {};
const pendingTasks = [];
const waitingForName = {};
let contacts = {};
const pendingImages = {};
const lastDraft = {};

loadContacts().then(data => { contacts = data; });

// ===== 品牌 Prompts =====
const BRAND_PROMPTS = {
  df: `你是大衛的 AI 助理，請根據提供的內容，產出【DF-OFFROAD】越野吉普車品牌的 IG 文章草稿。風格：賣態度、賣夢想、讓人想加入這個圈子。請包含內文和 3-5 個 hashtag。`,
  david: `你是大衛的 AI 助理，請根據提供的內容，產出【個人品牌 @davidcheng_lifestyle】的 IG 文章草稿。風格：像跟朋友說真心話，真實不裝。請包含內文和 3-5 個 hashtag。`,
  viebelle: `你是大衛的 AI 助理，請根據提供的內容，產出【Viebelle與蜜】的 IG 文章草稿。風格：看了就想吃，注重健康生活品質。請包含內文和 3-5 個 hashtag。`,
  charity: `你是大衛的 AI 助理，請根據提供的內容，產出【聖朝百年慈善】的 IG 文章草稿。風格：召集同伴，一起把好事傳承下去。請包含內文和 3-5 個 hashtag。`,
  all: `你是大衛的 AI 助理。請根據提供的內容，產出四個品牌的 IG 文章草稿：
1. 【DF-OFFROAD】越野吉普車品牌 - 風格：賣態度、賣夢想、讓人想加入這個圈子
2. 【個人品牌 @davidcheng_lifestyle】- 風格：像跟朋友說真心話，真實不裝
3. 【Viebelle與蜜】- 風格：看了就想吃，注重健康生活品質
4. 【聖朝百年慈善】- 風格：召集同伴，一起把好事傳承下去
請為每個品牌各產出一篇 IG 文章草稿，包含內文和 3-5 個 hashtag。`
};

const BRAND_MAP = {
  'df': 'df', 'df-offroad': 'df', '越野': 'df',
  'david': 'david', '個人': 'david', '個人品牌': 'david',
  'viebelle': 'viebelle', 'viebelle與蜜': 'viebelle', '麵包': 'viebelle',
  '聖朝': 'charity', '慈善': 'charity', 'charity': 'charity',
  '全部': 'all', 'all': 'all'
};

// ===== Webhook =====
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.json({ status: 'ok' });
  const events = req.body.events;

  for (const event of events) {
    const sourceType = event.source.type;
    const userId = event.source.userId;
    const isGroup = sourceType === 'group' || sourceType === 'room';
    const isDavid = userId === DAVID_USER_ID;

    // ===== 處理圖片訊息 =====
    if (event.type === 'message' && event.message.type === 'image' && isDavid) {
      pendingImages[userId] = {
        messageId: event.message.id,
        time: Date.now(),
      };
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '📸 圖片收到！請傳指令，例如：\n寫文案 df 幫我賣這個產品\n寫文案 viebelle\n寫文案 聖朝\n寫文案 david\n寫文案 全部' }],
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
        text: text,
      });
      if (groupMessages[groupId].length > 100) {
        groupMessages[groupId] = groupMessages[groupId].slice(-100);
      }
      if (text.includes('@摘要')) {
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
      }

    // ===== 大衛模式 =====
    } else if (isDavid) {

      if (text === '今天待辦' || text === '待辦清單') {
        if (pendingTasks.length === 0) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '✅ 今天目前沒有待辦事項。' }],
          });
        } else {
          const taskList = pendingTasks.map((t, i) => {
            const name = contacts[t.userId] ? contacts[t.userId].name : `陌生人(${t.userId.slice(-6)})`;
            return `${i + 1}. ${t.time} — ${name}：${t.text}`;
          }).join('\n');
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `📋 今天待辦（${pendingTasks.length}筆）\n\n${taskList}` }],
          });
        }

      } else if (text === '清空待辦') {
        pendingTasks.length = 0;
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '✅ 待辦清單已清空。' }],
        });

      } else if (text === '聯絡人清單') {
        if (Object.keys(contacts).length === 0) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '目前還沒有聯絡人記錄。' }],
          });
        } else {
          const list = Object.values(contacts).map(c => `${c.name}（${c.relation}）`).join('\n');
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `📒 聯絡人清單\n\n${list}` }],
          });
        }

      } else if (text.startsWith('秘書：') || text.startsWith('秘書:')) {
        const content = text.replace(/^秘書[：:]/, '');
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 800,
          messages: [{
            role: 'user',
            content: `你是大衛的秘書，請分析以下訊息並提供：
1. 緊急程度（🔴馬上處理 / 🟡今天內 / 🟢可以等）
2. 建議回覆文字
3. 注意事項
訊息內容：${content}`,
          }],
        });
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: response.content[0].text }],
        });

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
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '⏳ 正在幫你產出 IG 草稿，請稍等...' }],
          });

          let messages;
          if (hasImage) {
            const base64Image = await downloadImageAsBase64(imgData.messageId);
            delete pendingImages[userId];
            messages = [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
                { type: 'text', text: `${prompt}\n\n請根據這張照片${extraContent ? `和以下補充內容：${extraContent}` : ''}，產出 IG 文案。` }
              ]
            }];
          } else {
            messages = [{
              role: 'user',
              content: `${prompt}\n\n今天的內容：${extraContent || input}`
            }];
          }

          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 1000,
            messages,
          });

          lastDraft[userId] = response.content[0].text;

          await client.pushMessage({
            to: userId,
            messages: [{ type: 'text', text: response.content[0].text }],
          });
        } catch (error) {
          console.error('Error:', error);
        }

      } else if (text.startsWith('修改')) {
        const instruction = text.replace(/^修改[： ]?/, '').trim();
        const previous = lastDraft[userId];
        if (!previous) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ 還沒有暫存文案，請先用「寫文案」產出內容。' }],
          });
        } else {
          try {
            await client.replyMessage({
              replyToken: event.replyToken,
              messages: [{ type: 'text', text: '⏳ 正在修改文案，請稍等...' }],
            });
            const response = await anthropic.messages.create({
              model: 'claude-sonnet-4-5',
              max_tokens: 1000,
              messages: [{
                role: 'user',
                content: `以下是原本的 IG 文案：\n\n${previous}\n\n請根據以下要求修改：${instruction || '整體優化'}\n\n請直接給我修改後的完整文案。`
              }],
            });
            lastDraft[userId] = response.content[0].text;
            await client.pushMessage({
              to: userId,
              messages: [{ type: 'text', text: response.content[0].text }],
            });
          } catch (error) {
            console.error('Error:', error);
          }
        }

      } else if (text === '指令') {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `📋 大衛 AI 指令清單\n\n✍️ 文案\n寫文案 df [內容]\n寫文案 david [內容]\n寫文案 viebelle [內容]\n寫文案 聖朝 [內容]\n寫文案 全部 [內容]\n\n📸 照片文案\n先傳照片 → 再傳寫文案指令\n\n✏️ 修改文案\n修改 [修改要求]\n\n🗂 聯絡人\n聯絡人清單\n\n📋 待辦\n今天待辦\n清空待辦\n\n🤖 秘書\n秘書：[訊息內容]` }],
        });

      } else {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `收到！請用指令操作，傳「指令」查看完整清單。` }],
        });
      }

    // ===== 陌生人模式 =====
    } else {
      if (waitingForName[userId]) {
        const parts = text.split(/[,，、\s]+/);
        const name = parts[0] || text;
        const relation = parts[1] || '未知';
        contacts[userId] = { name, relation };
        delete waitingForName[userId];

        await saveContact(userId, name, relation);

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `謝謝您，${name}！我已幫您登記，大衛會盡快回覆您。` }],
        });
        if (DAVID_USER_ID) {
          await client.pushMessage({
            to: DAVID_USER_ID,
            messages: [{ type: 'text', text: `📨 新聯絡人登記！\n\n姓名：${name}\n關係：${relation}\n\n傳「今天待辦」查看所有訊息。` }],
          });
        }
      } else if (!contacts[userId]) {
        waitingForName[userId] = true;
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `您好！我是大衛的 AI 助理 🤖\n\n請問您的姓名是？以及您跟大衛是什麼關係？\n\n📝 格式：姓名，關係\n例如：王小明，工廠客戶` }],
        });
      } else {
        const name = contacts[userId].name;
        pendingTasks.push({
          time: new Date().toLocaleTimeString('zh-TW'),
          userId,
          text,
        });
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `您好，${name}！大衛目前很忙，我已幫您記錄訊息，他稍後會回覆您。謝謝！` }],
        });
        if (DAVID_USER_ID) {
          await client.pushMessage({
            to: DAVID_USER_ID,
            messages: [{ type: 'text', text: `📨 有新訊息！\n\n${name}說：${text}\n\n傳「今天待辦」查看所有訊息。` }],
          });
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
