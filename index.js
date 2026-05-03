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

const BRAND_PROMPTS = {
  default: `你是大衛的 AI 助理。大衛是一個台灣創業家，經營豆漿食品工廠、麵包店、越野吉普車品牌等多個事業。請根據他提供的內容，產出四個品牌的 IG 文章草稿：

1. 【DF-OFFROAD】越野吉普車品牌 - 風格：賣態度、賣夢想、讓人想加入這個圈子
2. 【個人品牌 @davidcheng_lifestyle】- 風格：像跟朋友說真心話，真實不裝
3. 【VBVieBelle 麵包】- 風格：看了就想吃，注重健康生活品質
4. 【聖朝百年慈善】- 風格：召集同伴，一起把好事傳承下去

請為每個品牌各產出一篇 IG 文章草稿，包含內文和 3-5 個 hashtag。格式如下：

---
📌 DF-OFFROAD
[內文]
[hashtag]

---
📌 個人品牌
[內文]
[hashtag]

---
📌 VBVieBelle
[內文]
[hashtag]

---
📌 聖朝百年慈善
[內文]
[hashtag]`
};

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.json({ status: 'ok' });
  
  const events = req.body.events;
  
  for (const event of events) {
    if (event.type !== 'message') continue;
    
    let userMessage = '';
    
    if (event.message.type === 'text') {
      userMessage = event.message.text;
    } else {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '請用文字描述你想分享的事情，我來幫你產出 IG 內容！' }]
      });
      continue;
    }
    
    try {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '⏳ 正在幫你產出四個品牌的 IG 草稿，請稍等...' }]
      });
      
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: `${BRAND_PROMPTS.default}\n\n今天的內容：${userMessage}`
          }
        ]
      });
      
      const draft = response.content[0].text;
      
      await client.pushMessage({
        to: event.source.userId,
        messages: [{ type: 'text', text: draft }]
      });
      
    } catch (error) {
      console.error('Error:', error);
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
