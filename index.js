const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');

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

const groupMessages = {};
const pendingTasks = [];
const DAVID_USER_ID = process.env.DAVID_USER_ID || '';

const BRAND_PROMPTS = `你是大衛的 AI 助理。大衛是一個台灣創業家，經營豆漿食品工廠、麵包店、越野吉普車品牌等多個事業。請根據他提供的內容，產出四個品牌的 IG 文章草稿：

1. 【DF-OFFROAD】越野吉普車品牌 - 風格：賣態度、賣夢想、讓人想加入這個圈子
2. 【個人品牌 @davidcheng_lifestyle】- 風格：像跟朋友說真心話，真實不裝
3. 【VBVieBelle 麵包】- 風格：看了就想吃，注重健康生活品質
4. 【聖朝百年慈善】- 風格：召集同伴，一起把好事傳承下去

請為每個品牌各產出一篇 IG 文章草稿，包含內文和 3-5 個 hashtag。`;

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.json({ status: 'ok' });

  const events = req.body.events;

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const text = event.message.text;
    const sourceType = event.source.type;
    const userId = event.source.userId;
    const isGroup = sourceType === 'group' || sourceType === 'room';
    const isDavid = userId === DAVID_USER_ID;

    if (isGroup) {
      const groupId = event.source.groupId || event.source.roomId;
      if (!groupMessages[groupId]) groupMessages[groupId] = [];
      groupMessages[groupId].push({
        time: new Date().toLocaleTimeString('zh-TW'),
        sender: userId,
        text: text
      });
      if (groupMessages[groupId].length > 100) {
        groupMessages[groupId] = groupMessages[groupId].slice(-100);
      }
      if (text.includes('@摘要')) {
        const msgs = groupMessages[groupId];
        const msgText = msgs.map(m => `${m.time}: ${m.text}`).join('\n');
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 800,
          messages: [{ role: 'user', content: `請整理以下群組訊息的重點，條列式：\n\n${msgText}` }]
        });
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '📋 群組摘要\n\n' + response.content[0].text }]
        });
      }

    } else if (isDavid) {
      if (text === '今天待辦' || text === '待辦清單') {
        if (pendingTasks.length === 0) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '✅ 今天目前沒有待辦事項。' }]
          });
        } else {
          const taskList = pendingTasks.map((t, i) => `${i + 1}. ${t.time} — ${t.text}`).join('\n');
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `📋 今天待辦事項（${pendingTasks.length}筆）\n\n${taskList}` }]
          });
        }
      } else if (text === '清空待辦') {
        pendingTasks.length = 0;
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '✅ 待辦清單已清空。' }]
        });
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

訊息內容：${content}`
          }]
        });
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: response.content[0].text }]
        });
      } else {
        try {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '⏳ 正在幫你產出四個品牌的 IG 草稿，請稍等...' }]
          });
          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 1000,
            messages: [{ role: 'user', content: `${BRAND_PROMPTS}\n\n今天的內容：${text}` }]
          });
          await client.pushMessage({
            to: userId,
            messages: [{ type: 'text', text: response.content[0].text }]
          });
        } catch (error) {
          console.error('Error:', error);
        }
      }

    } else {
      pendingTasks.push({
        time: new Date().toLocaleTimeString('zh-TW'),
        userId: userId,
        text: text
      });
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '您好！大衛目前很忙，我已幫您記錄訊息，他稍後會回覆您。謝謝！' }]
      });
      if (DAVID_USER_ID) {
        await client.pushMessage({
          to: DAVID_USER_ID,
          messages: [{ type: 'text', text: `📨 有新訊息！\n\n內容：${text}\n\n傳「今天待辦」查看所有訊息。` }]
        });
      }
    }
  }
});

app.get('/', (req, res) => {
  res.send('David AI Bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
