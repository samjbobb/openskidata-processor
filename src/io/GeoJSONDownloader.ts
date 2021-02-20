import bboxPolygon from "@turf/bbox-polygon";
import booleanContains from "@turf/boolean-contains";
import * as Fs from "fs";
import { readFile, writeFile } from "fs/promises";
import request from "request";
import streamToPromise from "stream-to-promise";
import * as tmp from "tmp";
import { InputSkiMapOrgSkiAreaFeature } from "../features/SkiAreaFeature";
import {
  liftsDownloadConfig,
  OSMDownloadConfig,
  runsDownloadConfig,
  skiAreasDownloadConfig,
  skiAreaSitesDownloadConfig,
  skiMapSkiAreasURL,
} from "./DownloadURLs";
import { GeoJSONInputPaths } from "./GeoJSONFiles";
import convertOSMFileToGeoJSON from "./OSMToGeoJSONConverter";

export default async function downloadAndConvertToGeoJSON(
  folder: string,
  bbox: GeoJSON.BBox | null
): Promise<GeoJSONInputPaths> {
  const paths = new GeoJSONInputPaths(folder);

  await Promise.all([
    downloadAndConvertOSMToGeoJSON(
      OSMEndpoint.Z,
      runsDownloadConfig,
      paths.runs,
      bbox
    ),
    (async () => {
      // Serialize downloads using the same endpoint so we don't get rate limited by the Overpass API
      await downloadAndConvertOSMToGeoJSON(
        OSMEndpoint.LZ4,
        liftsDownloadConfig,
        paths.lifts,
        bbox
      );
      await downloadAndConvertOSMToGeoJSON(
        OSMEndpoint.LZ4,
        skiAreasDownloadConfig,
        paths.skiAreas,
        bbox
      );
      // As sites are just relations, they are not representable in GeoJSON.
      await downloadOSMJSON(
        OSMEndpoint.LZ4,
        skiAreaSitesDownloadConfig,
        paths.skiAreaSites,
        bbox
      );
    })(),
    downloadSkiMapOrgSkiAreas(paths.skiMapSkiAreas, bbox),
  ]);

  return paths;
}

enum OSMEndpoint {
  LZ4 = "https://lz4.overpass-api.de/api/interpreter",
  Z = "https://z.overpass-api.de/api/interpreter",
}

async function downloadAndConvertOSMToGeoJSON(
  endpoint: OSMEndpoint,
  config: OSMDownloadConfig,
  targetGeoJSONPath: string,
  bbox: GeoJSON.BBox | null
): Promise<void> {
  const tempOSMPath = tmp.fileSync().name;

  await downloadOSMJSON(endpoint, config, tempOSMPath, bbox);

  convertOSMFileToGeoJSON(
    tempOSMPath,
    targetGeoJSONPath,
    config.shouldIncludeFeature
  );
}

async function downloadOSMJSON(
  endpoint: OSMEndpoint,
  config: OSMDownloadConfig,
  targetPath: string,
  bbox: GeoJSON.BBox | null
) {
  const url = overpassURLForQuery(endpoint, config.query(bbox));
  await downloadToFile(url, targetPath);
}

async function downloadSkiMapOrgSkiAreas(
  targetPath: string,
  bbox: GeoJSON.BBox | null
) {
  await downloadToFile(skiMapSkiAreasURL, targetPath);

  if (!bbox) {
    return;
  }

  // For consistency with the OSM data (which has the bounding box applied on Overpass API), apply bbox filtering on the downloaded GeoJSON.
  const bboxGeometry = bboxPolygon(bbox);
  const contents = await readFile(targetPath);
  const json: GeoJSON.FeatureCollection = JSON.parse(contents.toString());
  json.features = (json.features as InputSkiMapOrgSkiAreaFeature[]).filter(
    (feature) => booleanContains(bboxGeometry, feature)
  );

  await writeFile(targetPath, JSON.stringify(json));
}

async function downloadToFile(
  sourceURL: string,
  targetPath: string,
  retries: number = 10
): Promise<void> {
  try {
    await _downloadToFile(sourceURL, targetPath);
  } catch (e) {
    if (retries <= 0) {
      throw e;
    }

    console.log(
      "Download failed due to " + e + ". Will wait a minute and try again."
    );

    // Wait a bit in case we are rate limited by the server.
    await sleep(60000);

    await downloadToFile(sourceURL, targetPath, retries - 1);
  }
}

async function _downloadToFile(
  sourceURL: string,
  targetPath: string
): Promise<void> {
  const outputStream = Fs.createWriteStream(targetPath);
  let statusCode: number | null = null;
  let error: any = null;
  request(sourceURL, {
    timeout: 30 * 60 * 1000,
    headers: { Referer: "https://openskimap.org" },
  })
    .on("response", function (response) {
      statusCode = response.statusCode;
    })
    .on("error", function (err) {
      error = err;
    })
    .pipe(outputStream);
  await streamToPromise(outputStream);

  if (statusCode === null || statusCode < 200 || statusCode >= 300) {
    throw (
      "Failed downloading file at URL (status: " +
      statusCode +
      "): " +
      sourceURL
    );
  } else if (error) {
    console.error(error);
    throw error;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function overpassURLForQuery(endpoint: OSMEndpoint, query: string) {
  return endpoint + "?data=" + encodeURIComponent(query);
}
