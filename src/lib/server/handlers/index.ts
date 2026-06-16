/**
 * Handler registry. Each endpoint used to be its own api/<name>.ts Serverless
 * Function, but the Vercel Hobby plan caps a deployment at 12 functions and we
 * exceeded it (which froze prod and 404'd /api/x). They're now plain modules
 * dispatched by the single catch-all api/[...path].ts, so the whole site runs
 * as ONE function regardless of how many endpoints we add.
 */
import type { VercelRequest, VercelResponse } from '../vercel.js';
import analyze from './analyze.js';
import art from './art.js';
import artStream from './art-stream.js';
import deepzoom from './deepzoom.js';
import fetchHandler from './fetch.js';
import grab from './grab.js';
import iiif from './iiif.js';
import sauce from './sauce.js';
import scan from './scan.js';
import tile from './tile.js';
import x from './x.js';

export type Handler = (req: VercelRequest, res: VercelResponse) => unknown | Promise<unknown>;

export const handlers: Record<string, Handler> = {
  analyze,
  art,
  'art-stream': artStream,
  deepzoom,
  fetch: fetchHandler,
  grab,
  iiif,
  sauce,
  scan,
  tile,
  x,
};
