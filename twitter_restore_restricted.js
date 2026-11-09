// ==UserScript==
// @name         Twitter Restore Geo-Restricted Tweets
// @namespace    https://github.com/llyyr/twitter_restore_restricted
// @downloadURL  https://github.com/llyyr/twitter_restore_restricted/raw/master/twitter_restore_restricted.js
// @updateURL    https://github.com/llyyr/twitter_restore_restricted/raw/master/twitter_restore_restricted.js
// @version      0.1.0
// @author       llyyr
// @description  Restore tweets that are restricted due to local regulations using alternate services.
// @include      https://x.com/*
// @include      https://twitter.com/*
// @include      https://mobile.twitter.com/*
// @connect      api.fxtwitter.com
// @connect      api.vxtwitter.com
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @license      MIT
// ==/UserScript==

/*
0.1.0 - 09-11-2026
    Initial version.
*/


(() => {
    'use strict';

    const MESSAGE =
        'Due to local regulations, this content is restricted on X.';

    const states = new Map();
    const cache = new Map();
    const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;

    const numeric = value =>
        /^\d{5,}$/.test(String(value || '')) ? String(value) : null;

    const entryID = value =>
        String(value || '').match(/^tweet-(\d{5,})(?:-|$)/)?.[1];

    const statusID = value =>
        String(value || '').match(/\/status\/(\d{5,})(?:[/?#]|$)/)?.[1];

    function propsID(root) {
        const queue = [[root, false]];
        const seen = new Set();
        const paths = [
            'item', 'entry', 'content', 'itemContent',
            'tweet_results', 'tweetResult', 'result', 'tweet', 'data'
        ];

        for (let i = 0; i < queue.length && i < 60; i++) {
            const [value, isTweet] = queue[i];

            if (!value ||
                typeof value !== 'object' ||
                Array.isArray(value) ||
                seen.has(value)) continue;

            seen.add(value);

            const id =
                entryID(value.entryId) ||
                    entryID(value.entry_id) ||
                    entryID(value.itemId) ||
                    numeric(value.tweetId) ||
                    numeric(value.tweet_id) ||
                    ((isTweet || value.__typename === 'Tweet') &&
                        (numeric(value.rest_id) || numeric(value.id_str)));

            if (id) return id;

            for (const key of paths) {
                if (value[key]) {
                    queue.push([value[key], isTweet || /tweet/i.test(key)]);
                }
            }
        }

        return null;
    }

    function getID(article) {
        for (
        let element = article;
        element;
        element = element.parentElement
    ) {
            try {
                const descriptors = page.Object.getOwnPropertyDescriptors(
                    element.wrappedJSObject || element
                );

                for (const [key, descriptor] of Object.entries(descriptors)) {
                    if (key.startsWith('__reactProps$')) {
                        const id = propsID(descriptor.value);
                        if (id) return id;
                    }

                    if (!key.startsWith('__reactFiber$') &&
                        !key.startsWith('__reactInternalInstance$')) continue;

                    let fiber = descriptor.value;

                    for (
                    let depth = 0;
                    fiber && depth < 25;
                    depth++, fiber = fiber.return
                ) {
                        const id =
                            entryID(fiber.key) ||
                                propsID(fiber.memoizedProps);

                        if (id) return id;
                    }
                }
            } catch {
            }

            if (element.matches('[data-testid="cellInnerDiv"]')) break;
        }

        const timestamp = article.querySelector('time');

        return statusID(
            timestamp?.closest('a[href]')?.getAttribute('href')
        ) || null;
    }

    const providers = [
        {
            name: 'FxTwitter / FixupX',
            url: id => `https://api.fxtwitter.com/status/${id}`,

            parse(data) {
                const t = data?.tweet;
                if (!t) throw Error('Tweet unavailable');

                return {
                    text: t.text || '',
                    author: t.author?.screen_name,
                    media: t.media?.all || []
                };
            }
        },
        {
            name: 'VxTwitter / FixVX',
            url: id => `https://api.vxtwitter.com/Twitter/status/${id}`,

            parse(t) {
                if (typeof t?.text !== 'string') {
                    throw Error('Tweet unavailable');
                }

                return {
                    text: t.text,
                    author: t.user_screen_name,
                    media: t.media_extended?.length
                        ? t.media_extended
                        : (t.mediaURLs || []).map(url => ({
                            url,
                            type: /\.(mp4|webm)(?:[?#]|$)/i.test(url)
                                ? 'video'
                                : 'image'
                        }))
                };
            }
        },
    ];

    const cooldowns = new Map();
    const fetchQueue = [];
    let activeFetches = 0;

    function request(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                anonymous: true,
                timeout: 15000,

                onload(response) {
                    try {
                        if (response.status !== 200) {
                            const error = Error(`HTTP ${response.status}`);
                            error.status = response.status;

                            const retry = response.responseHeaders
                            ?.match(/^retry-after:\s*([^\r\n]+)/im)?.[1]
                            ?.trim();

                            error.retryAfter = !retry
                                ? 0
                                : /^\d+$/.test(retry)
                                    ? Number(retry) * 1000
                                    : Math.max(0, Date.parse(retry) - Date.now()) || 0;

                            throw error;
                        }

                        resolve(JSON.parse(response.responseText));
                    } catch (error) {
                        reject(error);
                    }
                },

                onerror: () => reject(Error('Network error')),
                ontimeout: () => reject(Error('Request timed out'))
            });
        });
    }

    function shuffled(items) {
        const result = [...items];

        for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }

        return result;
    }

    async function tryProviders(id) {
        const available = providers.filter(provider =>
            (cooldowns.get(provider.name) || 0) <= Date.now()
        );

        for (const provider of shuffled(available)) {
            try {
                const response = await request(provider.url(id));
                const tweet = provider.parse(response);

                if (!tweet.text && !tweet.media.length) {
                    throw Error('Empty tweet');
                }

                return tweet;
            } catch (error) {
                console.debug(
                    `[Restricted tweets] ${provider.name}:`,
                    error.message
                );

                const temporaryFailure =
                    [401, 403, 429].includes(error.status) ||
                        error.status >= 500 ||
                        (!error.status &&
                            /Network|timed out|JSON|Unexpected/i.test(error.message));

                if (temporaryFailure) {
                    cooldowns.set(
                        provider.name,
                        Date.now() + Math.max(
                            error.status === 403 ? 300000 : 60000,
                            error.retryAfter || 0
                        )
                    );
                }
            }
        }

        throw Error('No provider could retrieve this tweet');
    }

    function pumpFetches() {
        while (activeFetches < 2 && fetchQueue.length) {
            const { id, resolve, reject } = fetchQueue.shift();
            activeFetches++;

            tryProviders(id)
                .then(resolve, reject)
                .finally(() => {
                    activeFetches--;
                    pumpFetches();
                });
        }
    }

    function fetchTweet(id) {
        if (cache.has(id)) return cache.get(id);

        const pending = new Promise((resolve, reject) => {
            fetchQueue.push({ id, resolve, reject });
        });

        cache.set(id, pending);

        pending.catch(() => {
            setTimeout(() => {
                if (cache.get(id) === pending) cache.delete(id);
            }, 60000);
        });

        pumpFetches();
        return pending;
    }

    function safeURL(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' ? url.href : null;
        } catch {
            return null;
        }
    }

    function addLink(parent, text, url) {
        const href = safeURL(url);
        if (!href) return;

        const a = document.createElement('a');
        a.href = href;
        a.textContent = text;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.style.cssText =
            'display:block;color:#1d9bf0;margin-top:8px';

        parent.append(a);
    }


    function clear(article, state) {
        if (state.hidden) {
            state.notice.style.display = state.display;
        }

        for (const [element, display] of state.covered || []) {
            element.style.display = display;
        }

        if ('copyFlag' in state) {
            if (state.copyFlag === null) {
                article.removeAttribute('data-fixupx-copy-button');
            } else {
                article.setAttribute('data-fixupx-copy-button', state.copyFlag);
            }
        }

        state.panel.remove();
        states.delete(article);
    }

    function render(panel, tweet, id) {
        const article = panel.closest('article');
        const state = states.get(article);

        const native = [...document.querySelectorAll(
            '[data-testid="tweetText"]'
        )].find(node => !node.closest('[data-restored-tweet]'));

        const style = getComputedStyle(native || article);
        const handle = encodeURIComponent(tweet.author || 'i');
        const permalink = `https://x.com/${handle}/status/${id}`;

        function element(tag, css = '') {
            const node = document.createElement(tag);
            node.style.cssText = css;
            return node;
        }

        article.prepend(panel);

        state.covered = [...article.children]
            .filter(node => node !== panel)
            .map(node => [node, node.style.display]);

        for (const [node] of state.covered) {
            node.style.display = 'none';
        }

        state.copyFlag = article.getAttribute('data-fixupx-copy-button');
        article.removeAttribute('data-fixupx-copy-button');

        panel.replaceChildren();
        panel.style.cssText = [
            'display:block',
            'width:100%',
            'min-width:0',
            'box-sizing:border-box',
            'padding:12px 16px',
            'text-align:start',
            `color:${style.color}`,
            `font-family:${style.fontFamily}`,
            `font-size:${native ? style.fontSize : '15px'}`,
            `line-height:${native ? style.lineHeight : '20px'}`
        ].join(';');

        const header = element(
            'div',
            'display:flex;align-items:center;gap:8px;min-width:0'
        );

        const identity = element(
            'div',
            'display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0'
        );
        identity.dataset.testid = 'User-Name';

        if (tweet.author) {
            const author = element(
                'a',
                'color:inherit;font-weight:700;text-decoration:none'
            );
            author.href = `https://x.com/${handle}`;
            author.textContent = '@' + tweet.author;
            identity.append(author);
        }

        const status = element(
            'a',
            'color:rgb(113,118,123);text-decoration:none;font-size:13px'
        );
        status.href = permalink;
        status.title = 'Open original post';

        const time = document.createElement('time');
        time.textContent = 'View post';
        status.append(time);
        identity.append(status);
        header.append(identity);

        const controls = element(
            'div',
            'display:flex;margin-left:auto;align-items:center'
        );
        header.append(controls);

        let cursor = controls;
        for (let i = 0; i < 3; i++) {
            const wrapper = element('div', 'display:flex;align-items:center');
            cursor.append(wrapper);
            cursor = wrapper;
        }

        const menu = element('details', 'position:relative');

        const more = element(
            'summary',
            'list-style:none;cursor:pointer;color:rgb(113,118,123);padding:4px 8px;font-size:20px'
        );
        more.setAttribute('aria-label', 'More');
        more.textContent = '⋯';

        const items = element('div', [
            'position:absolute',
            'right:0',
            'top:100%',
            'z-index:20',
            'min-width:170px',
            'padding:8px 12px',
            'border:1px solid #71767b',
            'border-radius:12px',
            'background:Canvas',
            'color:CanvasText',
            'box-shadow:0 2px 8px #0003'
        ].join(';'));

        addLink(items, 'Open on X', permalink);
        addLink(
            items,
            'Open on FixupX',
            `https://fixupx.com/${handle}/status/${id}`
        );

        menu.append(more, items);
        cursor.append(menu);
        panel.append(header);

        const body = element(
            'div',
            'white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px'
        );
        body.dataset.testid = 'tweetText';
        body.dir = 'auto';
        body.textContent = tweet.text;
        panel.append(body);

        const attachments = tweet.media
        .map(media => ({ ...media, url: safeURL(media.url) }))
        .filter(media => media.url);

        if (!attachments.length) return;

        const gallery = element('div', [
            'display:grid',
            `grid-template-columns:${
attachments.length > 1
? 'repeat(2,minmax(0,1fr))'
: 'minmax(0,1fr)'
}`,
            'gap:2px',
            'margin-top:12px',
            'border:1px solid #71767b40',
            'border-radius:16px',
            'overflow:hidden'
        ].join(';'));

        attachments.forEach((media, index) => {
            const video = /video|gif/i.test(media.type || '');
            const frame = element('div', 'min-width:0;overflow:hidden');

            if (attachments.length === 3 && index === 0) {
                frame.style.gridRow = 'span 2';
            }

            const attachment = element(
                video ? 'video' : 'img',
                'display:block;width:100%;height:auto;max-height:75vh;object-fit:contain'
            );

            if (video) {
                attachment.controls = true;
                attachment.playsInline = true;
                attachment.preload = 'none';

                const poster = safeURL(media.thumbnail_url);
                if (poster) attachment.poster = poster;
            } else {
                attachment.alt = `Attachment ${index + 1}`;
                attachment.loading = 'lazy';
                attachment.referrerPolicy = 'no-referrer';

                const imageLink = element('a', 'display:block');
                imageLink.href = permalink + `/photo/${index + 1}`;

                imageLink.addEventListener('click', event => {
                    event.preventDefault();
                    window.open(
                        attachment.currentSrc || attachment.src,
                        '_blank',
                        'noopener,noreferrer'
                    );
                });

                imageLink.append(attachment);
                frame.append(imageLink);
            }

            attachment.addEventListener('error', () => {
                attachment.style.display = 'none';
                addLink(frame, `Open attachment ${index + 1}`, media.url);
            }, { once: true });
            let source = media.url;

            if (!video) {
                const url = new URL(source);

                if (
                    url.hostname === 'pbs.twimg.com' &&
                        url.pathname.startsWith('/media/')
                ) {
                    url.pathname = url.pathname.replace(
                        /:(orig|large|medium|small|thumb)$/,
                        ''
                    );

                    url.searchParams.set('name', 'large');
                    url.hash = '';
                    source = url.href;
                }
            }

            attachment.src = source;

            if (video) frame.append(attachment);
            gallery.append(frame);
        });

        panel.append(gallery);
    }



    function processArticle(article) {
        const walker = document.createTreeWalker(
            article,
            NodeFilter.SHOW_TEXT
        );

        let node;
        let notice;

        while ((node = walker.nextNode())) {
            if (
                !node.parentElement.closest('[data-restored-tweet]') &&
                    node.nodeValue.replace(/\s+/g, ' ').includes(MESSAGE)
            ) {
                notice =
                    node.parentElement.closest('[dir="auto"]') ||
                        node.parentElement;
                break;
            }
        }

        const previous = states.get(article);

        if (!notice) {
            if (previous) clear(article, previous);
            return;
        }

        const id = getID(article);

        if (previous) {
            if (
                previous.id === id &&
                    previous.notice === notice &&
                    previous.panel.isConnected
            ) return;

            clear(article, previous);
        }

        const panel = document.createElement('div');
        panel.dataset.restoredTweet = '';
        panel.style.cssText = [
            'display:block',
            'padding:12px',
            'color:inherit',
            'font-size:15px',
            'line-height:1.5',
            'text-align:left'
        ].join(';');

        panel.textContent = id
            ? 'Loading alternate tweet…'
            : 'Cannot identify this tweet: X exposed no tweet ID on this card.';

        panel.addEventListener('click', event => event.stopPropagation());
        notice.after(panel);

        const state = {
            id,
            notice,
            panel,
            hidden: false,
            display: notice.style.display
        };

        states.set(article, state);

        if (!id) return;

        const current = () =>
            states.get(article) === state &&
                panel.isConnected &&
                getID(article) === id &&
                notice.textContent.includes(MESSAGE);

        fetchTweet(id).then(tweet => {
            if (!current()) return;

            render(panel, tweet, id);
            notice.style.display = 'none';
            state.hidden = true;
        }).catch(() => {
                if (!current()) return;

                panel.textContent =
                    'Both alternate services failed to retrieve this tweet.';

                addLink(panel, 'Try FixupX', `https://fixupx.com/i/status/${id}`);
                addLink(panel, 'Try VxTwitter', `https://vxtwitter.com/i/status/${id}`);
            });
    }

    const dirty = new Set();
    let scheduled = false;

    function processNode(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
            node = node.parentElement;
        }
        if (!node) return;

        const article = node.closest('article');
        if (article) dirty.add(article);

        node.querySelectorAll('article').forEach(a => dirty.add(a));

        if (scheduled) return;
        scheduled = true;

        requestAnimationFrame(() => {
            scheduled = false;

            for (const [a, state] of states) {
                if (!a.isConnected) clear(a, state);
            }

            const batch = [...dirty];
            dirty.clear();

            batch.forEach(a => {
                if (a.isConnected) processArticle(a);
            });
        });
    }

    processNode(document.body);

    new MutationObserver(mutations => {
        for (const { addedNodes, target } of mutations) {
            addedNodes.forEach(processNode);
            processNode(target);
        }
    }).observe(document.body, {
            childList: true,
            characterData: true,
            subtree: true
        });

    setInterval(() => processNode(document.body), 1000);
})();
