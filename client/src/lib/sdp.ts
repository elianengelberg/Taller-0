// By default Chrome negotiates Opus around ~32kbps for voice, which is
// noticeably muddy. Bump the encoder up to a much higher target bitrate and
// turn off DTX (which mutes audio during "silence" and can clip the start
// of words) so calls sound closer to music-quality instead of phone-quality.
export function boostOpusAudio(sdp: string): string {
  const rtpmapMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000/);
  if (!rtpmapMatch) return sdp;

  const payload = rtpmapMatch[1];
  const extraParams = "maxaveragebitrate=128000;stereo=0;useinbandfec=1;cbr=0;dtx=0";
  const fmtpRegex = new RegExp(`a=fmtp:${payload} .*`);

  if (fmtpRegex.test(sdp)) {
    return sdp.replace(fmtpRegex, (line) => `${line};${extraParams}`);
  }

  const rtpmapLineRegex = new RegExp(`(a=rtpmap:${payload} opus/48000[^\r\n]*\r?\n)`);
  return sdp.replace(rtpmapLineRegex, `$1a=fmtp:${payload} ${extraParams}\r\n`);
}
