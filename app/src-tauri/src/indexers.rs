/* Search and feeds, which are the same XML wearing two hats.
 *
 * Torznab — what Prowlarr, Jackett, Sonarr and Radarr all speak — is RSS 2.0 with one extra
 * namespace: results come back as <item>s, and the numbers a search needs (seeders, size) arrive
 * as <torznab:attr name="seeders" value="42"/>. So a single parser covers both search results
 * and a plain RSS feed, and the `rss` crate hands over the namespaced elements unchanged.
 *
 * There is deliberately no built-in list of indexers. flai ships knowing about no sites at all:
 * you point it at your own Prowlarr or Jackett and it asks that. Which is also how Sonarr and
 * Radarr work, and it is the difference between a search feature and a directory of other
 * people's copyright problems.
 */

use anyhow::{Context, Result};
use rss::Channel;
use serde::Serialize;

use crate::settings::{Feed, Indexer};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub title: String,
    /// A magnet, or an http link to a .torrent. librqbit accepts either, so neither is special.
    pub url: String,
    pub size: u64,
    pub seeders: u32,
    pub leechers: u32,
    /// Which indexer answered, so a result can be judged by where it came from.
    pub indexer: String,
}

/// Ten seconds: an indexer that has not answered by then is down, and search should say so
/// rather than hang behind it.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

async fn fetch(url: &str, params: &[(&str, &str)]) -> Result<Channel> {
    let body = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()?
        .get(url)
        .query(params)
        .send()
        .await
        .context("could not reach it")?
        .error_for_status()
        .context("it refused the request")?
        .bytes()
        .await?;
    Channel::read_from(&body[..]).context("the answer was not a feed")
}

/// Reads one `<torznab:attr name="…" value="…">`.
fn attr(item: &rss::Item, want: &str) -> Option<String> {
    item.extensions()
        .get("torznab")?
        .get("attr")?
        .iter()
        .find(|e| e.attrs.get("name").map(String::as_str) == Some(want))
        .and_then(|e| e.attrs.get("value").cloned())
}

fn number(item: &rss::Item, want: &str) -> u32 {
    attr(item, want).and_then(|v| v.parse().ok()).unwrap_or(0)
}

/* The download link, in the order of preference that actually matters.
 *
 * A magnet needs no round trip and no API key, so it wins when the indexer offers one. Otherwise
 * the enclosure URL is the .torrent, and it usually carries the key in its query string already —
 * which is why it is passed to librqbit verbatim rather than picked apart. */
fn link(item: &rss::Item) -> Option<String> {
    if let Some(magnet) = attr(item, "magneturl") {
        return Some(magnet);
    }
    if let Some(url) = item.enclosure().map(|e| e.url.clone()) {
        if !url.is_empty() {
            return Some(url);
        }
    }
    item.link().map(str::to_string)
}

fn size(item: &rss::Item) -> u64 {
    attr(item, "size")
        .and_then(|v| v.parse().ok())
        .or_else(|| item.enclosure().and_then(|e| e.length.parse().ok()))
        .unwrap_or(0)
}

fn hits(channel: Channel, indexer: &str) -> Vec<Hit> {
    channel
        .into_items()
        .into_iter()
        .filter_map(|item| {
            Some(Hit {
                title: item.title().unwrap_or("untitled").to_string(),
                url: link(&item)?,
                size: size(&item),
                seeders: number(&item, "seeders"),
                leechers: number(&item, "leechers"),
                indexer: indexer.to_string(),
            })
        })
        .collect()
}

/// Asks every configured indexer at once and merges the answers, best-seeded first.
///
/// One indexer being down must not lose the others' results, so a failure is dropped rather than
/// propagated. An empty list back means nothing matched *or* nothing answered — which the UI
/// reports as one thing, because to the person searching it is one thing.
pub async fn search(indexers: &[Indexer], query: &str) -> Vec<Hit> {
    let mut set = tokio::task::JoinSet::new();
    for indexer in indexers {
        let (url, key, name) = (
            indexer.url.clone(),
            indexer.api_key.clone(),
            indexer.name.clone(),
        );
        let query = query.to_string();
        set.spawn(async move {
            let channel = fetch(
                &url,
                &[
                    ("t", "search"),
                    ("apikey", &key),
                    ("q", &query),
                    ("limit", "50"),
                ],
            )
            .await
            .ok()?;
            Some(hits(channel, &name))
        });
    }

    let mut all: Vec<Hit> = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Some(found)) = joined {
            all.extend(found);
        }
    }
    all.sort_by(|a, b| b.seeders.cmp(&a.seeders));
    all
}

/// One poll of one feed: everything matching the filter that has not been seen before.
///
/// Returns the hits *and* the guids to remember. The caller does the remembering because it owns
/// the settings file, and a feed that forgot what it had added would re-download the lot.
pub async fn poll(feed: &Feed) -> Result<(Vec<Hit>, Vec<String>)> {
    let channel = fetch(&feed.url, &[]).await?;
    let filter = feed.contains.to_lowercase();

    let mut fresh = Vec::new();
    let mut guids = Vec::new();
    for item in channel.into_items() {
        let title = item.title().unwrap_or_default().to_string();
        if !filter.is_empty() && !title.to_lowercase().contains(&filter) {
            continue;
        }
        // Falling back to the link keeps feeds that omit a guid working, and a link is stable
        // enough to deduplicate on.
        let Some(guid) = item
            .guid()
            .map(|g| g.value().to_string())
            .or_else(|| item.link().map(str::to_string))
        else {
            continue;
        };
        if feed.seen.iter().any(|s| *s == guid) {
            continue;
        }
        let Some(url) = link(&item) else { continue };
        guids.push(guid);
        fresh.push(Hit {
            title,
            url,
            size: size(&item),
            seeders: number(&item, "seeders"),
            leechers: number(&item, "leechers"),
            indexer: feed.name.clone(),
        });
    }
    Ok((fresh, guids))
}
