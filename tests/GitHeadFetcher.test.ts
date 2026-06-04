import zlib from 'zlib';
import {describe, expect, it} from 'vitest';
import {JsonCache} from '../Cache/JsonCache.js';
import {GitHeadFetcher, HeadTarballFetcher} from '../Releases/GitHeadFetcher.js';

const BLOCK = 512;

function tarHeader(name: string, size: number): Buffer {
    const h = Buffer.alloc(BLOCK);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644 ', 100, 8, 'ascii');
    h.write('0000000 ', 108, 8, 'ascii');
    h.write('0000000 ', 116, 8, 'ascii');
    h.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
    h.write('00000000000 ', 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h.write('0', 156, 1, 'ascii');
    h.write('ustar', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
        sum += h[i];
    }
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return h;
}

function tgz(topDir: string, version: string): Buffer {
    const body = Buffer.from(JSON.stringify({name: 'figtree', version}), 'utf-8');
    const padded = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK);
    body.copy(padded);
    const parts: Buffer[] = [
        tarHeader(`${topDir}/package.json`, body.length),
        padded,
        Buffer.alloc(BLOCK)
    ];
    return zlib.gzipSync(Buffer.concat(parts));
}

function stubFetcher(map: Record<string, Buffer|null>): HeadTarballFetcher {
    return {
        async fetch(url: string): Promise<Buffer|null> {
            if (!(url in map)) {
                throw new Error(`unexpected fetch ${url}`);
            }
            return map[url];
        }
    };
}

describe('GitHeadFetcher', () => {
    it('returns version + sha for a github URL with the codeload prefix', async () => {
        const sha = 'a'.repeat(40);
        const buf = tgz(`figtree-${sha}`, '1.0.28');
        const fetcher = new GitHeadFetcher(null, {
            fetcher: stubFetcher({
                'https://codeload.github.com/stefanwerfling/figtree/tar.gz/HEAD': buf
            })
        });

        const info = await fetcher.fetch('git+https://github.com/stefanwerfling/figtree.git');
        expect(info).not.toBeNull();
        expect(info!.version).toBe('1.0.28');
        expect(info!.sha).toBe(sha);
        expect(info!.shortSha).toBe(sha.slice(0, 7));
    });

    it('forces HEAD regardless of the ref the user pinned', async () => {
        const sha = 'b'.repeat(40);
        const buf = tgz(`figtree-${sha}`, '1.0.99');
        const fetcher = new GitHeadFetcher(null, {
            fetcher: stubFetcher({
                'https://codeload.github.com/stefanwerfling/figtree/tar.gz/HEAD': buf
            })
        });

        const info = await fetcher.fetch('git+https://github.com/stefanwerfling/figtree.git#v1.0.26');
        expect(info?.version).toBe('1.0.99');
        expect(info?.sha).toBe(sha);
    });

    it('returns version null but still surfaces the sha when package.json is missing', async () => {
        const sha = 'c'.repeat(40);
        // tarball with no package.json — just an empty README
        const body = Buffer.from('# placeholder', 'utf-8');
        const padded = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK);
        body.copy(padded);
        const buf = zlib.gzipSync(Buffer.concat([
            tarHeader(`figtree-${sha}/README.md`, body.length),
            padded,
            Buffer.alloc(BLOCK)
        ]));
        const fetcher = new GitHeadFetcher(null, {
            fetcher: stubFetcher({
                'https://codeload.github.com/o/figtree/tar.gz/HEAD': buf
            })
        });

        const info = await fetcher.fetch('git+https://github.com/o/figtree.git');
        expect(info?.version).toBeNull();
        expect(info?.sha).toBe(sha);
    });

    it('returns null for an unknown host without giteaHosts configured', async () => {
        let called = false;
        const fetcher = new GitHeadFetcher(null, {
            fetcher: {
                async fetch() {
                    called = true;
                    return null;
                }
            }
        });
        const info = await fetcher.fetch('git+https://forge.example.com/o/figtree.git');
        expect(info).toBeNull();
        expect(called).toBe(false);
    });

    it('routes to the gitea archive endpoint when host is allow-listed', async () => {
        // Gitea tarballs typically don't encode the SHA in the folder
        // name, so `sha` stays null; `version` still comes through.
        const buf = tgz('figtree', '2.0.0');
        const fetcher = new GitHeadFetcher(null, {
            giteaHosts: ['gitea.example.com'],
            fetcher: stubFetcher({
                'https://gitea.example.com/o/figtree/archive/HEAD.tar.gz': buf
            })
        });

        const info = await fetcher.fetch('git+https://gitea.example.com/o/figtree.git');
        expect(info?.version).toBe('2.0.0');
        expect(info?.sha).toBeNull();
    });

    it('caches the result under a TTL pocket so a second call skips the fetch', async () => {
        const sha = 'd'.repeat(40);
        const buf = tgz(`figtree-${sha}`, '1.0.28');
        let fetchCount = 0;
        const cache = new JsonCache('/tmp/nppm-githead-' + Math.random().toString(36).slice(2), 60);
        const fetcher = new GitHeadFetcher(cache, {
            fetcher: {
                async fetch(url) {
                    fetchCount++;
                    if (url === 'https://codeload.github.com/o/figtree/tar.gz/HEAD') {
                        return buf;
                    }
                    return null;
                }
            }
        });

        await fetcher.fetch('git+https://github.com/o/figtree.git');
        await fetcher.fetch('git+https://github.com/o/figtree.git');
        expect(fetchCount).toBe(1);
    });
});