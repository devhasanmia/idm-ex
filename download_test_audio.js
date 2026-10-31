const { Ytdl } = require('@distube/ytdl-core');
const fs = require('fs');
const https = require('https');

async function testDownloadAudio() {
  const ytdl = new Ytdl();
  const info = await ytdl.getInfo('https://www.youtube.com/watch?v=6WUl11LD_wM');
  const aFormat = info.formats.find(f => f.hasAudio && !f.hasVideo && f.url && f.container === 'mp4');
  console.log('Audio itag:', aFormat.itag, 'Bitrate:', aFormat.audioBitrate, 'ContentLength:', aFormat.contentLength);

  const file = fs.createWriteStream('C:/idm-rs/test_audio.m4a');
  https.get(aFormat.url, (res) => {
    res.pipe(file);
    file.on('finish', () => {
      console.log('Audio downloaded successfully!');
      process.exit(0);
    });
  });
}

testDownloadAudio();

