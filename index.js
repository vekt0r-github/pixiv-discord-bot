const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();   // Load Enviroment

const { Client, Intents, MessageAttachment, MessageEmbed } = require('discord.js');
const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES] });

client.on('ready', () => {
  console.log(`Logged in...`);
});

const getId = s => {
  const match = s.match(/^!nya.*pixiv.net\/[^ ]*\/?artworks\/([0-9]+)/);
  if (!match || !/[0-9]+/.test(match[1])) { return; }
  return match[1];
}

const isError = (data) => {
  if (data.error) { console.error('Failed ', data.message); }
  return data.error;
}

const getImage = (imageURL, referer) => { // async
  return axios.get(imageURL, {
    headers: { referer },
    responseType: 'stream',
  });
}

client.on("messageCreate", async function (message) {
  if (message.author.bot) return;
  const pixivId = getId(message.content);
  if (!pixivId) return;
  // get channel id and command out of message
//   const channelId = message.channel.id;
  const pixivLink = `https://www.pixiv.net/artworks/${pixivId}`;
  
  const illustResponse = await axios.get(`https://www.pixiv.net/ajax/illust/${pixivId}`, {});
  if (isError(illustResponse.data)) return;
  const illustData = illustResponse.data.body;

  const artistResponse = await axios.get(`https://www.pixiv.net/ajax/user/${illustData.userId}`, {});
  if (isError(artistResponse.data)) return;
  const artistData = artistResponse.data.body;

  const image = await getImage(illustData.urls.original, pixivLink);
  const thumbnail = await getImage(artistData.imageBig, pixivLink);
  if (isError(image) || isError(thumbnail)) return;
  // console.log(Object.keys(image.data))
  const imageAttachment = new MessageAttachment(image.data, 'image.jpg');
  const thumbnailAttachment = new MessageAttachment(thumbnail.data, 'thumbnail.jpg');

  const imageEmbed = new MessageEmbed()
    .setAuthor({
      name: illustData.userName,
      url: `https://www.pixiv.net/users/${illustData.userId}`,
    })
    .setTitle(illustData.title)
    .setDescription(illustData.description.replace(/<[^>]+>/g, ''))
    .setThumbnail('attachment://thumbnail.jpg')
    .setImage('attachment://image.jpg')
    .setFooter({
      text: `pixiv ・ ${new Date(illustData.uploadDate).toDateString()}`
    });
  message.suppressEmbeds(true);
  message.reply({
    content: pixivLink,
    embeds: [imageEmbed],
    files: [imageAttachment, thumbnailAttachment],
  });
});

client.login(process.env.BOT_TOKEN);