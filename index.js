const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();   // Load Enviroment

const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder, RESTJSONErrorCodes } = require('discord.js');
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const BUG_MSG = `bug vekt0r to check the logs`;
const MAX_PAGE_COUNT = 9;
const MAX_FILE_SIZE = 24; // megabytes (limit is 25mb but add bit of error)

client.on('ready', () => {
  console.log(`Logged in...`);
});

const getId = s => {
  const match = s.match(/pixiv.net\/[^ ]*\/?artworks\/([0-9]+)/);
  if (!match || !/[0-9]+/.test(match[1])) { return; }
  return match[1];
}

const parseArgs = msg => {
  const args = msg.split(' ');
  let options = {};
  if (args[0] !== '!nya') return options;
  for (let i = 0; i < args.length; i++) {
    const testId = getId(args[i]);
    if (testId) options.id = testId;
    else if (args[i].includes('=')) {
      const [key, value] = args[i].split('=');
      options[key] = value;
    }
  }
  return options;
}

const isError = (data) => {
  if (data.error) { console.error('Failed ', data.message); }
  return data.error;
}

const getFileExtension = (filename) => {
  return filename.split('.').pop();
}

const getImage = async (imageURL, referer, limit = MAX_FILE_SIZE * 1024 * 1024) => {
  let image;
  if (imageURL) {
    image = await axios.get(imageURL, {
      headers: { referer },
      responseType: 'arraybuffer',
      // maxContentLength: MAX_FILE_SIZE * 1024 * 1024, 
    });
  }
  if (!image || isError(image)) {
    console.warn(`failed to fetch image from ${imageURL}`);
    return undefined;
  }
  const dataSize = image.data.length;
  console.log(`successfully fetched image from ${imageURL} with ${dataSize} bytes`);
  if (dataSize > limit) { // image too large (above max file size)
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
 * @param {*} pageNumber current index; *zero indexed*
 * @param {*} logger to log progress with side effects
 * @returns promise of imageAttachment or undefined if not found
 */
const findLargestPossibleImage = async (urls, pixivLink, pageNumber, logger) => {
  logger.log(`fetching image for page ${pageNumber + 1}...`)
  const possibleSizes = ['original', 'regular', 'small'];
  for (const size of possibleSizes) {
    if (!urls[size]) continue;
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
  const options = parseArgs(message.content);
  const pixivId = options.id;
  if (!pixivId) return;
  const selectedPagesArg = options.pages ?? options.page ?? '';
  let selectedPages = selectedPagesArg.split(',').map(s => parseInt(s)).filter(x => !isNaN(x) && x > 0);
  
  const errors = [];
  const logMessage = await message.channel.send('logs:');
  const logger = {
    content: logMessage.content,
    sendToLog(str) { this.content += '\n' + str; logMessage.edit(this.content); },
    date(str) { return `[${new Date().toISOString()}] ${str}`; },
    log(str) { console.log(this.date(str)); this.sendToLog(str); },
    warn(str) { console.warn(this.date(str)); this.sendToLog(str); },
    error(str) { console.error(this.date(str)); this.sendToLog(str); errors.push(this.date(str)); },
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
  if (!pageCount) {
    logger.warn(`bad pageCount: ${illustData.pageCount}; defaulting to 1`);
    pageCount = 1;
  }
  if (selectedPages.length > 0) {
    // get specific pages
    if (selectedPages.length > MAX_PAGE_COUNT) {
      logger.warn(`warning: clipping number of images to ${MAX_PAGE_COUNT} (attempted to pass in ${selectedPages.length})`);
      selectedPages.splice(MAX_PAGE_COUNT);
    }
    for (const selectedPage of selectedPages) {
      if (selectedPage >= pageCount) {
        logger.warn(`warning: requested page (${selectedPage}) is greater than page count (${pageCount}); this image will likely fail`);
      }
    }
    logger.log(`fetching images for these pages: ${selectedPages.join(', ')}...`)
  } else {
    // get all pages
    if (pageCount > MAX_PAGE_COUNT) {
      logger.warn(`warning: clipping number of images to ${MAX_PAGE_COUNT} (from ${pageCount})`);
      pageCount = MAX_PAGE_COUNT;
    }
    logger.log(`fetching images for ${pageCount} pages...`)
    selectedPages = [...new Array(pageCount).keys()].map(x => x + 1);
  }

  for (const page of selectedPages) {
    const imageAttachment = await findLargestPossibleImage(illustData.urls, pixivLink, page - 1, logger);
    if (!imageAttachment) {
      logger.error(`no images under ${MAX_FILE_SIZE}MB found for page ${page} of ${pageCount}`);
      continue;
    }
    const imageEmbed = createEmbed(illustData, imageAttachment.name, thumbnailAttachment.name);
    files.push(imageAttachment);
    embeds.push(imageEmbed);
  }

  // compute discord bot message
  let content = `${pixivLink} (${selectedPages.length} images)`;
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
    if (err.code === RESTJSONErrorCodes.RequestEntityTooLarge) {
      // possible message is over limit when individual files aren't?
      logger.warn(`message is somehow still too large`);
    }
    logger.error(`discord error (${err.code}): ${err.message}\n${BUG_MSG}`);
  });
});

client.login(process.env.BOT_TOKEN);