const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();   // Load Enviroment

const { Client, Intents, MessageAttachment, MessageEmbed, Constants } = require('discord.js');
const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES] });

const BUG_MSG = `bug vekt0r to check the logs`;

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
    responseType: 'arraybuffer',
    // maxContentLength: 7.5 * 1024 * 1024, 
  });
}

client.on("messageCreate", async function (message) {
  if (message.author.bot) return;
  const pixivId = getId(message.content);
  if (!pixivId) return;
  const pixivLink = `https://www.pixiv.net/artworks/${pixivId}`;
  console.log(`\nreceived valid request for ${pixivLink}`);
  
  // gather necessary data from pixiv
  const illustResponse = await axios.get(`https://www.pixiv.net/ajax/illust/${pixivId}`, {});
  if (isError(illustResponse.data)) return;
  const illustData = illustResponse.data.body;

  const artistResponse = await axios.get(`https://www.pixiv.net/ajax/user/${illustData.userId}`, {});
  if (isError(artistResponse.data)) return;
  const artistData = artistResponse.data.body;
  const thumbnail = await getImage(artistData.imageBig, pixivLink);
  if (isError(thumbnail)) console.log(`failed to get artist thumbnail; continuing`);

  // get image-- original size may be too big; try downsizing until it works
  const possibleSizes = ['original', 'regular', 'small'];
  let size, image;
  for (size of possibleSizes) {
    image = await getImage(illustData.urls[size], pixivLink);
    if (isError(image)) {
      console.log(`failed to get ${size} size image`);
      continue;
    }
    const dataSize = image.data.length;
    console.log(`successfully got ${size} size image with ${dataSize} bytes`);
    if (dataSize > 7.5 * 1024 * 1024) { // image too large (above 7.5mb)
      console.log(`too big; continuing`);
      image = undefined;
    } else {
      break;
    }
  }
  if (!image) {
    console.log(`no images successfully found`);
    message.reply({
      content: `couldn't successfully get any images under 7.5MB\n${BUG_MSG}`,
    });
    return;
  }

  // compute discord bot message
  // note: trying multiple times to send messages here fails in weird ways
  const imageAttachment = new MessageAttachment(image.data, `image-${size}.jpg`);
  const thumbnailAttachment = isError(thumbnail) ? undefined : new MessageAttachment(thumbnail.data, `thumbnail-${size}.jpg`);

  const imageEmbed = new MessageEmbed()
    .setAuthor({
      name: illustData.userName,
      url: `https://www.pixiv.net/users/${illustData.userId}`,
    })
    .setTitle(illustData.title)
    .setDescription(illustData.description.replace(/<[^>]+>/g, ''))
    .setImage(`attachment://image-${size}.jpg`)
    .setFooter({
      text: `pixiv ・ ${new Date(illustData.uploadDate).toDateString()}`
    });
  const files = [imageAttachment];
  if (thumbnailAttachment) {
    imageEmbed.setThumbnail(`attachment://thumbnail-${size}.jpg`);
    files.push(thumbnailAttachment);
  }
  message.reply({
    content: pixivLink,
    embeds: [imageEmbed],
    files: files,
  }).then(() => {
    console.log(`successfully sent message with ${size} size image`);
    message.suppressEmbeds(true);
    finished = true;
  }).catch((err) => {
    if (err.code === Constants.APIErrors.REQUEST_ENTITY_TOO_LARGE) { // message over 8mb
      console.log(`message is somehow still too large; ${BUG_MSG}`);
    } else {
      console.error(err);
      message.reply({
        content: `discord error (${err.code}): ${err.message}\n${BUG_MSG}`,
      });
    }
  });
});

client.login(process.env.BOT_TOKEN);