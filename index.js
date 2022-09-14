const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();   // Load Enviroment

const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder, RESTJSONErrorCodes } = require('discord.js');
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

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

const getFileExtension = (filename) => {
  return filename.split('.').pop();
}

const getImage = async (imageURL, referer, limit = 7.5 * 1024 * 1024) => {
  let image;
  if (imageURL) {
    image = await axios.get(imageURL, {
      headers: { referer },
      responseType: 'arraybuffer',
      // maxContentLength: 7.5 * 1024 * 1024, 
    });
  }
  if (!image || isError(image)) {
    console.warn(`failed to fetch image from ${imageURL}`);
    return undefined;
  }
  const dataSize = image.data.length;
  console.log(`successfully fetched image from ${imageURL} with ${dataSize} bytes`);
  if (dataSize > limit) { // image too large (above 7.5mb)
    console.log(`image was too big (${dataSize} > ${limit})`);
    return undefined;
  }
  return image;
}

const getImageAttachment = async (imageURL, referer, identifier) => {
  const image = await getImage(imageURL, referer);
  if (!image) return undefined;
  const filename = `${identifier}.${getFileExtension(imageURL)}`;
  return new AttachmentBuilder(image.data, { name: filename });
}

/**
 * get image-- original size may be too big; try downsizing until it works
 * @param {*} urls object with keys 'original', 'regular', 'small', etc.
 * @param {*} pixivLink the referer to access images
 * @param {*} pageNumber current index
 * @param {*} logger to log progress with side effects
 * @returns promise of imageAttachment or undefined if not found
 */
const findLargestPossibleImage = async (urls, pixivLink, pageNumber, logger) => {
  logger.log(`fetching image for page ${pageNumber}...`)
  const possibleSizes = ['original', 'regular', 'small'];
  for (const size of possibleSizes) {
    const url = urls[size].replace("_p0", `_p${pageNumber}`); // hopefully this is the only instance
    const imageAttachment = await getImageAttachment(url, pixivLink, `image-p${pageNumber}`);
    if (!imageAttachment) {
      logger.log(`failed to get ${size} size image`);
      continue;
    }
    logger.log(`successfully got ${size} size image`);
    return imageAttachment;
  }
  return undefined;
}

/**
 * generates a discord embed containing an image
 * @param {*} imageFilename unique indentifier; not undefined
 * @param {*} thumbnailFilename could be undefined
 * @returns the discord embed
 */
const createEmbed = (illustData, imageFilename, thumbnailFilename) => {
  const imageEmbed = new EmbedBuilder()
    .setURL('https://github.com/vekt0r-github/pixiv-discord-bot')
    .setAuthor({
      name: illustData.userName,
      url: `https://www.pixiv.net/users/${illustData.userId}`,
    })
    .setImage(`attachment://${imageFilename}`)
    .setFooter({
      text: `pixiv ・ ${new Date(illustData.uploadDate).toDateString()}`
    });
  if (illustData.title) imageEmbed.setTitle(illustData.title);
  const description = illustData.description.replace(/<[^>]+>/g, '');
  if (description) imageEmbed.setDescription(description);
  if (thumbnailFilename) {
    imageEmbed.setThumbnail(`attachment://${thumbnailFilename}`);
  }
  return imageEmbed;
}

client.on("messageCreate", async function (message) {
  if (message.author.bot) return;
  const pixivId = getId(message.content);
  if (!pixivId) return;
  
  const errors = [];
  const logMessage = await message.channel.send('logs:');
  const logger = {
    content: logMessage.content,
    sendToLog(str) { this.content += '\n' + str; logMessage.edit(this.content); },
    log(str) { console.log(str); this.sendToLog(str); },
    warn(str) { console.warn(str); this.sendToLog(str); },
    error(str) { console.error(str); this.sendToLog(str); errors.push(str); },
  }

  const pixivLink = `https://www.pixiv.net/artworks/${pixivId}`;
  logger.log(`\nreceived valid request for ${pixivLink}`);
  logMessage.suppressEmbeds(true); // since this contains a link
  
  // gather necessary data from pixiv
  const illustResponse = await axios.get(`https://www.pixiv.net/ajax/illust/${pixivId}`, {});
  if (isError(illustResponse.data)) return;
  const illustData = illustResponse.data.body;

  const artistResponse = await axios.get(`https://www.pixiv.net/ajax/user/${illustData.userId}`, {});
  if (isError(artistResponse.data)) return;
  const artistData = artistResponse.data.body;

  // create all embeds and attachments (including fetching images)  
  const files = [];
  const embeds = [];

  const thumbnailAttachment = await getImageAttachment(artistData.imageBig, pixivLink, "thumbnail");
  if (thumbnailAttachment) files.push(thumbnailAttachment);

  let pageCount = parseInt(illustData.pageCount);
  const MAX_PAGE_COUNT = 9;
  if (!pageCount) {
    logger.warn(`bad pageCount: ${illustData.pageCount}; defaulting to 1`);
    pageCount = 1;
  } else if (pageCount > MAX_PAGE_COUNT) {
    const err = `warning: clipping number of images to ${MAX_PAGE_COUNT} (from ${pageCount})`;
    logger.warn(err);
    pageCount = MAX_PAGE_COUNT;
  }
  logger.log(`fetching images for ${pageCount} pages...`)
  for (let page = 0; page < pageCount; page++) {
    const imageAttachment = await findLargestPossibleImage(illustData.urls, pixivLink, page, logger);
    if (!imageAttachment) {
      const err = `no images under 7.5MB found for page ${page} of ${pageCount}`;
      logger.error(err);
      continue;
    }
    const imageEmbed = createEmbed(illustData, imageAttachment.name, thumbnailAttachment.name);
    files.push(imageAttachment);
    embeds.push(imageEmbed);
  }

  // compute discord bot message
  let content = `${pixivLink} (${pageCount}${pageCount === MAX_PAGE_COUNT ? '+' : ''} images)`;
  if (errors.length) {
    errors.push(BUG_MSG);
    content += '\n' + errors.join('\n');
  }
  message.reply({
    content: content,
    embeds: embeds,
    files: files,
  }).then(() => {
    console.log(`successfully sent message with ${embeds.length} images`);
    message.suppressEmbeds(true);
    logMessage.delete();
  }).catch((err) => {
    if (err.code === RESTJSONErrorCodes.RequestEntityTooLarge) { // message over 8mb
      logger.warn(`message is somehow still too large`);
    }
    logger.error(`discord error (${err.code}): ${err.message}\n${BUG_MSG}`);
  });
});

client.login(process.env.BOT_TOKEN);