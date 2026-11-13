import { composeFallback, type Description, type EntityRecord } from '@eio/core';

/**
 * Offline stand-in for `GET /api/describe/:entityId`. The ISS text is the English Wikipedia summary exactly as the real lookup
 * returned it (apps/server/test/fixtures/wikipedia-summary-iss.json). ESA DISCOS is 'off' (needs a token) and every other object
 * gets only the fallback line, so the mock shows no invented facts.
 */
const ISS_TEXT =
  'The International Space Station (ISS) is a space station in low Earth orbit (LEO). It is the product of the International Space Station program and is operated by five partner space agencies: NASA, Roscosmos (Russia), ESA (Europe), JAXA (Japan), and CSA (Canada). It is the first space station built, maintained and crewed through international cooperation and the largest human spacecraft ever constructed. It is an orbital research station, where scientific experiments in microgravity are conducted and the space environment is studied. Since 2 November 2000, it has hosted the longest continuous human presence in space. Alongside China\'s Tiangong, it is one of two currently operational space stations.';

export function mockDescription(rec: EntityRecord, nowMs = Date.now()): Description {
  const d: Description = {
    entityId: rec.id,
    fallback: composeFallback(rec),
    searchUrl: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(rec.name)}`,
    sources: { wikidata: 'miss', wikipedia: 'miss', discos: 'off' },
    fetchedAt: nowMs,
  };
  const norad = Number(rec.aliases?.norad);
  if (Number.isInteger(norad) && norad > 0) d.norad = norad;
  if (rec.id === 'sat-25544') {
    d.wikidata = { id: 'Q25271', url: 'https://www.wikidata.org/wiki/Q25271', label: 'International Space Station' };
    d.summary = {
      title: 'International Space Station', text: ISS_TEXT, url: 'https://en.wikipedia.org/wiki/International_Space_Station',
      blurb: 'Modular space station in low Earth orbit',
      thumbnail: {
        url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/59/The_station_pictured_from_the_SpaceX_Crew_Dragon_5.jpg/330px-The_station_pictured_from_the_SpaceX_Crew_Dragon_5.jpg',
        width: 330, height: 219,
      },
    };
    d.sources = { wikidata: 'ok', wikipedia: 'ok', discos: 'off' };
  }
  return d;
}
