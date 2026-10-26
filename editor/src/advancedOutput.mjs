// Reads Resolume Arena's AdvancedOutput.xml. Arena writes it in a fixed, regular shape,
// so plain string scanning is enough and keeps this module usable outside the browser.

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? decodeEntities(match[1]) : '';
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Every <tag ...>...</tag> block directly searchable in `xml`, in document order.
function blocks(xml, tag) {
  const result = [];
  const open = new RegExp(`<${tag}[\\s>]`, 'g');
  let match;
  while ((match = open.exec(xml))) {
    const close = xml.indexOf(`</${tag}>`, match.index);
    if (close < 0) break;
    const headEnd = xml.indexOf('>', match.index);
    result.push({ head: xml.slice(match.index, headEnd + 1), body: xml.slice(headEnd + 1, close) });
    open.lastIndex = close;
  }
  return result;
}

function vertices(xml) {
  const points = [];
  for (const match of xml.matchAll(/<v\s[^>]*>/g)) {
    points.push([parseFloat(attribute(match[0], 'x')), parseFloat(attribute(match[0], 'y'))]);
  }
  return points;
}

function firstParam(body, name) {
  const match = body.match(new RegExp(`<Param name="${name}"[^>]*>`));
  return match ? attribute(match[0], 'value') : '';
}

function layerPoints(type, body) {
  const container = type === 'Slice' ? 'InputRect' : 'InputContour';
  const found = blocks(body, container)[0];
  return found ? vertices(found.body) : [];
}

function outputPoints(type, body) {
  const container = type === 'Slice' ? 'OutputRect' : 'OutputContour';
  const found = blocks(body, container)[0];
  return found ? vertices(found.body) : [];
}

/**
 * @returns {{compWidth:number, compHeight:number, screens:Array, slices:Array}}
 * Slices come in the order Arena's slice panel shows them (oldest first within each screen).
 */
export function parseAdvancedOutput(xml) {
  const sizeTag = xml.match(/<CurrentCompositionTextureSize[^>]*>/);
  const compWidth = sizeTag ? parseFloat(attribute(sizeTag[0], 'width')) : 0;
  const compHeight = sizeTag ? parseFloat(attribute(sizeTag[0], 'height')) : 0;
  if (!(compWidth > 0 && compHeight > 0)) throw new Error('No composition size in AdvancedOutput.xml');

  const screens = [];
  const slices = [];
  for (const screen of blocks(xml, 'Screen')) {
    const screenId = attribute(screen.head, 'uniqueId');
    const device = screen.body.match(/<OutputDevice\w*\s[^>]*width="[^"]*"[^>]*>/);
    screens.push({
      id: screenId,
      name: firstParam(screen.body, 'Name') || attribute(screen.head, 'name'),
      width: device ? parseFloat(attribute(device[0], 'width')) : 0,
      height: device ? parseFloat(attribute(device[0], 'height')) : 0,
    });

    const layersBlock = blocks(screen.body, 'layers')[0];
    if (!layersBlock) continue;
    const screenSlices = [];
    const layerTag = /<(Slice|Polygon)\s[^>]*uniqueId="[^"]*"[^>]*>/g;
    let match;
    while ((match = layerTag.exec(layersBlock.body))) {
      const type = match[1];
      const close = layersBlock.body.indexOf(`</${type}>`, match.index);
      if (close < 0) break;
      const body = layersBlock.body.slice(match.index + match[0].length, close);
      layerTag.lastIndex = close;
      const points = layerPoints(type, body);
      if (points.length < 3) continue;
      screenSlices.push({
        id: attribute(match[0], 'uniqueId'),
        name: firstParam(body, 'Name'),
        screen: screenId,
        points,
        outPoints: outputPoints(type, body),
      });
    }
    slices.push(...screenSlices.reverse());
  }
  return { compWidth, compHeight, screens, slices };
}
