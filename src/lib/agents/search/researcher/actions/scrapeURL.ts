import z from 'zod';
import { ResearchAction } from '../../types';
import { Chunk, ReadingResearchBlock } from '@/lib/types';
import TurnDown from 'turndown';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';

const execFileAsync = promisify(execFile);
const YTDLP = '/usr/local/searxng/searx-pyenv/bin/yt-dlp';

function isYouTubeUrl(url: string): boolean {
  return /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)/.test(url);
}

function parseVTT(vtt: string): string {
  const seen = new Set<string>();
  return vtt
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t === 'WEBVTT') return false;
      if (/^Kind:|^Language:|^\d{2}:\d{2}:\d{2}/.test(t)) return false;
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .join(' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '');
}

async function fetchYouTubeTranscript(
  url: string,
): Promise<{ title: string; text: string }> {
  const { stdout: titleOut } = await execFileAsync(YTDLP, [
    '--print',
    'title',
    '--no-playlist',
    '--quiet',
    url,
  ]);
  const title = titleOut.trim() || 'YouTube Video';

  const tmpBase = `${os.tmpdir()}/yt_${crypto.randomUUID()}`;
  try {
    await execFileAsync(YTDLP, [
      '--write-auto-subs',
      '--write-subs',
      '--sub-langs',
      'en',
      '--skip-download',
      '--sub-format',
      'vtt',
      '--no-playlist',
      '--quiet',
      '-o',
      tmpBase,
      url,
    ]);

    const vttPath = `${tmpBase}.en.vtt`;
    const vtt = fs.readFileSync(vttPath, 'utf-8');
    fs.unlinkSync(vttPath);

    const text = parseVTT(vtt);
    if (!text.trim()) throw new Error('empty transcript');

    return { title, text };
  } catch {
    // clean up any leftover tmp files
    try {
      fs
        .readdirSync(os.tmpdir())
        .filter((f) => f.startsWith(`yt_${tmpBase.split('yt_')[1]}`))
        .forEach((f) => fs.unlinkSync(`${os.tmpdir()}/${f}`));
    } catch {}
    throw new Error('transcript unavailable');
  }
}

const turndownService = new TurnDown();

const schema = z.object({
  urls: z.array(z.string()).describe('A list of URLs to scrape content from.'),
});

const actionDescription = `
Use this tool to scrape and extract content from the provided URLs. This is useful when you the user has asked you to extract or summarize information from specific web pages. You can provide up to 3 URLs at a time. NEVER CALL THIS TOOL EXPLICITLY YOURSELF UNLESS INSTRUCTED TO DO SO BY THE USER.
You should only call this tool when the user has specifically requested information from certain web pages, never call this yourself to get extra information without user instruction.

For example, if the user says "Please summarize the content of https://example.com/article", you can call this tool with that URL to get the content and then provide the summary or "What does X mean according to https://example.com/page", you can call this tool with that URL to get the content and provide the explanation.
`;

const scrapeURLAction: ResearchAction<typeof schema> = {
  name: 'scrape_url',
  schema: schema,
  getToolDescription: () =>
    'Use this tool to scrape and extract content from the provided URLs. This is useful when you the user has asked you to extract or summarize information from specific web pages. You can provide up to 3 URLs at a time. NEVER CALL THIS TOOL EXPLICITLY YOURSELF UNLESS INSTRUCTED TO DO SO BY THE USER.',
  getDescription: () => actionDescription,
  enabled: (_) => true,
  execute: async (params, additionalConfig) => {
    params.urls = params.urls.slice(0, 3);

    let readingBlockId = crypto.randomUUID();
    let readingEmitted = false;

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    );

    const results: Chunk[] = [];

    await Promise.all(
      params.urls.map(async (url) => {
        try {
          if (isYouTubeUrl(url)) {
            try {
              const { title, text: transcriptText } =
                await fetchYouTubeTranscript(url);

              if (
                !readingEmitted &&
                researchBlock &&
                researchBlock.type === 'research'
              ) {
                readingEmitted = true;
                researchBlock.data.subSteps.push({
                  id: readingBlockId,
                  type: 'reading',
                  reading: [{ content: '', metadata: { url, title } }],
                });
                additionalConfig.session.updateBlock(
                  additionalConfig.researchBlockId,
                  [
                    {
                      op: 'replace',
                      path: '/data/subSteps',
                      value: researchBlock.data.subSteps,
                    },
                  ],
                );
              } else if (
                readingEmitted &&
                researchBlock &&
                researchBlock.type === 'research'
              ) {
                const subStepIndex = researchBlock.data.subSteps.findIndex(
                  (step: any) => step.id === readingBlockId,
                );
                const subStep = researchBlock.data.subSteps[
                  subStepIndex
                ] as ReadingResearchBlock;
                subStep.reading.push({ content: '', metadata: { url, title } });
                additionalConfig.session.updateBlock(
                  additionalConfig.researchBlockId,
                  [
                    {
                      op: 'replace',
                      path: '/data/subSteps',
                      value: researchBlock.data.subSteps,
                    },
                  ],
                );
              }

              results.push({
                content: `[YouTube Transcript]\n\n${transcriptText}`,
                metadata: { url, title },
              });
              return;
            } catch {
              // no transcript available — fall through to HTML scrape
            }
          }

          const res = await fetch(url);
          const text = await res.text();

          const title =
            text.match(/<title>(.*?)<\/title>/i)?.[1] || `Content from ${url}`;

          if (
            !readingEmitted &&
            researchBlock &&
            researchBlock.type === 'research'
          ) {
            readingEmitted = true;
            researchBlock.data.subSteps.push({
              id: readingBlockId,
              type: 'reading',
              reading: [
                {
                  content: '',
                  metadata: {
                    url,
                    title: title,
                  },
                },
              ],
            });

            additionalConfig.session.updateBlock(
              additionalConfig.researchBlockId,
              [
                {
                  op: 'replace',
                  path: '/data/subSteps',
                  value: researchBlock.data.subSteps,
                },
              ],
            );
          } else if (
            readingEmitted &&
            researchBlock &&
            researchBlock.type === 'research'
          ) {
            const subStepIndex = researchBlock.data.subSteps.findIndex(
              (step: any) => step.id === readingBlockId,
            );

            const subStep = researchBlock.data.subSteps[
              subStepIndex
            ] as ReadingResearchBlock;

            subStep.reading.push({
              content: '',
              metadata: {
                url,
                title: title,
              },
            });

            additionalConfig.session.updateBlock(
              additionalConfig.researchBlockId,
              [
                {
                  op: 'replace',
                  path: '/data/subSteps',
                  value: researchBlock.data.subSteps,
                },
              ],
            );
          }

          const markdown = turndownService.turndown(text);

          results.push({
            content: markdown,
            metadata: {
              url,
              title: title,
            },
          });
        } catch (error) {
          results.push({
            content: `Failed to fetch content from ${url}: ${error}`,
            metadata: {
              url,
              title: `Error fetching ${url}`,
            },
          });
        }
      }),
    );

    return {
      type: 'search_results',
      results,
    };
  },
};

export default scrapeURLAction;
