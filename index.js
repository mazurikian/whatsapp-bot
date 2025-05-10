const fs = require("fs/promises");
const path = require("path");
const gtts = require("node-gtts")("es");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: "/usr/bin/google-chrome-stable",
    headless: true,
  },
});
const chatHistories = {};
const messageDeleteQueue = [];
const mutedUsers = {};
const spamTracker = {};
async function processMessageQueue() {
  if (messageDeleteQueue.length) {
    const { msg } = messageDeleteQueue.shift();
    await msg.delete(true);
  }
}
setInterval(processMessageQueue, 1000);
client.initialize();
client.on("loading_screen", (percent, message) => {
  console.log("LOADING SCREEN", percent, message);
});
let pairingCodeRequested = false;
client.on("qr", async (qr) => {
  console.log("QR RECEIVED", qr);
  const pairingCodeEnabled = false;
  if (pairingCodeEnabled && !pairingCodeRequested) {
    const pairingCode = await client.requestPairingCode("96170100100");
    console.log("Pairing code enabled, code: " + pairingCode);
    pairingCodeRequested = true;
  }
});
client.on("authenticated", () => {
  console.log("AUTHENTICATED");
});
client.on("auth_failure", (msg) => {
  console.error("AUTHENTICATION FAILURE", msg);
});
client.on("ready", async () => {
  console.log("READY");
  const debugWWebVersion = await client.getWWebVersion();
  console.log(`WWebVersion = ${debugWWebVersion}`);
  client.pupPage.on("pageerror", function (err) {
    console.log("Page error: " + err.toString());
  });
  client.pupPage.on("error", function (err) {
    console.log("Page error: " + err.toString());
  });
});
client.on("message", async (msg) => {
  console.log("MESSAGE RECEIVED", msg);
  const chat = await msg.getChat();
  if (!chat.isGroup) return;
  const botId = client.info.wid._serialized;
  const chatId = chat.id._serialized;
  const senderId = msg.author;
  const chatKey = `${chatId}-${senderId}`;
  const botIsAdmin = chat.participants.some(
    (p) => p.id._serialized === botId && p.isAdmin,
  );
  const senderIsAdmin = chat.participants.some(
    (p) => p.id._serialized === senderId && p.isAdmin,
  );
  const isMuted =
    botIsAdmin && mutedUsers[chatId] && mutedUsers[chatId].includes(senderId);
  const isSpam =
    !senderIsAdmin &&
    botIsAdmin &&
    (msg.body.length >= 32768 ||
      msg.body.includes("chat.whatsapp.com") ||
      ["location", "vcard"].includes(msg.type));
  if (isMuted || isSpam) {
    messageDeleteQueue.push({ msg });
    if (isSpam) {
      spamTracker[senderId] = (spamTracker[senderId] || 0) + 1;
      if (
        spamTracker[senderId] >= 5 &&
        chat.participants.some((p) => p.id._serialized === senderId)
      ) {
        await chat.removeParticipants([senderId]);
      }
    }
    return;
  }
  if (msg.body.startsWith("!ai ")) {
    try {
      const input = msg.body.slice(4).trim();
      if (!chatHistories[chatKey]) chatHistories[chatKey] = [];
      chatHistories[chatKey].push({ role: "user", parts: [{ text: input }] });
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=AIzaSyBV9cHqygWjwfEZxpXp-K9aB4kAWsB0Z2g",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: chatHistories[chatKey] }),
        },
      );
      const data = await res.json();
      const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (aiText) {
        chatHistories[chatKey].push({
          role: "model",
          parts: [{ text: aiText }],
        });
        await msg.reply(aiText);
      }
    } catch (err) {
      await msg.reply(err.message);
    }
    return;
  }
  if (msg.body.startsWith("!kick") && senderIsAdmin && botIsAdmin) {
    try {
      if (msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        const targetId = quotedMsg.author;
        if (targetId !== botId) {
          await chat.removeParticipants([targetId]);
        }
      } else if (msg.mentionedIds) {
        for (const mentionedId of msg.mentionedIds) {
          if (mentionedId !== botId) {
            await chat.removeParticipants([mentionedId]);
          }
        }
      }
    } catch (err) {
      await msg.reply(err.message);
    }
    return;
  }
  if (msg.body.startsWith("!mute") && senderIsAdmin && botIsAdmin) {
    try {
      if (!mutedUsers[chatId]) mutedUsers[chatId] = [];
      if (msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        const targetId = quotedMsg.author;
        if (targetId !== botId && !mutedUsers[chatId].includes(targetId)) {
          mutedUsers[chatId].push(targetId);
          await msg.reply("🔇 Usuario silenciado en el grupo.");
        }
      } else if (msg.mentionedIds) {
        for (const mentionedId of msg.mentionedIds) {
          if (
            mentionedId !== botId &&
            !mutedUsers[chatId].includes(mentionedId)
          ) {
            mutedUsers[chatId].push(mentionedId);
            await msg.reply(
              "🔇 Usuario(s) mencionado(s) silenciado(s) en el grupo.",
            );
          }
        }
      }
    } catch (err) {
      await msg.reply(err.message);
    }
    return;
  }
  if (msg.body === "!sticker") {
    try {
      let media;
      if (msg.type === "image" || msg.type === "video") {
        media = await msg.downloadMedia();
      } else if (msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg.type === "image" || quotedMsg.type === "video") {
          media = await quotedMsg.downloadMedia();
        }
      }
      if (media) {
        await msg.reply(media, undefined, { sendMediaAsSticker: true });
      }
    } catch (err) {
      await msg.reply(err.message);
    }
    return;
  }
  if (msg.body.startsWith("!tts ")) {
    try {
      const text = msg.body.slice(5).trim();
      const filePath = path.join(__dirname, `${Date.now()}.mp3`);
      gtts.save(filePath, text, async () => {
        const media = MessageMedia.fromFilePath(filePath);
        await msg.reply(media, undefined, { sendAudioAsVoice: true });
        await fs.unlink(filePath);
      });
    } catch (err) {
      await msg.reply(err.message);
    }
    return;
  }
  if (msg.body.startsWith("!unmute") && senderIsAdmin && botIsAdmin) {
    try {
      if (mutedUsers[chatId]) {
        if (msg.hasQuotedMsg) {
          const quotedMsg = await msg.getQuotedMessage();
          const targetId = quotedMsg.author;
          if (targetId !== botId && mutedUsers[chatId].includes(targetId)) {
            mutedUsers[chatId] = mutedUsers[chatId].filter(
              (id) => id !== targetId,
            );
            await msg.reply("🔊 Usuario des-silenciado en el grupo.");
          }
        } else if (msg.mentionedIds) {
          for (const mentionedId of msg.mentionedIds) {
            if (
              mentionedId !== botId &&
              mutedUsers[chatId].includes(mentionedId)
            ) {
              mutedUsers[chatId] = mutedUsers[chatId].filter(
                (id) => id !== mentionedId,
              );
              await msg.reply(
                "🔊 Usuario(s) mencionado(s) des-silenciado(s) en el grupo.",
              );
            }
          }
        }
      }
    } catch (err) {
      await msg.reply(err.message);
    }
    return;
  }
});
client.on("message_ciphertext", (msg) => {
  msg.body = "Waiting for this message. Check your phone.";
});
client.on("change_state", (state) => {
  console.log("CHANGE STATE", state);
});
let rejectCalls = true;
client.on("call", async (call) => {
  if (rejectCalls) await call.reject();
});
client.on("disconnected", (reason) => {
  console.log("Client was logged out", reason);
});
client.on("group_admin_changed", (notification) => {
  if (notification.type === "promote") {
    console.log(`You were promoted by ${notification.author}`);
  } else if (notification.type === "demote")
    console.log(`You were demoted by ${notification.author}`);
});
