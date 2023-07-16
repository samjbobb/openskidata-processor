#!/bin/bash
set -ex

MY_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd $MY_DIR

RUN_MODE=$1

if [[ "$RUN_MODE" != "--skip-download" ]]; then
	echo "Downloading..."
	npm run download
fi

if [ -z "$CLUSTERING_ARANGODB_URL" ]; then
		echo "Starting clustering DB..."
    docker compose up -d arangodb
    CLUSTERING_ARANGODB_URL="http://$(docker compose port arangodb 8529)"
    sleep 5
fi

if [ -z "$ELEVATION_SERVER_URL" ]; then
		echo "Starting elevation service..."
    docker compose up -d elevation-service
    ELEVATION_SERVER_URL="http://$(docker compose port elevation-service 3000)"
    sleep 5
fi

echo "Converting to GeoJSON..."
#GEOCODING_SERVER_URL="https://photon.komoot.io/reverse" CLUSTERING_ARANGODB_URL=$CLUSTERING_ARANGODB_URL npm run prepare-geojson
CLUSTERING_ARANGODB_URL=$CLUSTERING_ARANGODB_URL ELEVATION_SERVER_URL=$ELEVATION_SERVER_URL npm run prepare-geojson

docker compose run tippecanoe \
  tippecanoe -Q -o /data/planet_lifts.mbtiles \
		-f -z 15 -Z 5 --simplify-only-low-zooms \
		--drop-densest-as-needed \
		--named-layer=lifts:/data/mapboxgl_lifts.geojson;

docker compose run tippecanoe \
  tippecanoe -Q -o /data/planet_runs.mbtiles \
		-f -z 15 -Z 9 --simplify-only-low-zooms \
		--drop-densest-as-needed \
	  --named-layer=runs:/data/mapboxgl_runs.geojson;

docker compose run tippecanoe \
  tippecanoe -Q -o /data/ski_areas.mbtiles \
		-f -z 15 -Z 0 -B 0 \
		--named-layer=skiareas:/data/mapboxgl_ski_areas.geojson;

docker compose run tippecanoe \
  tile-join -f --no-tile-size-limit -o /data/openskimap.mbtiles /data/ski_areas.mbtiles /data/planet_runs.mbtiles /data/planet_lifts.mbtiles;

rm -Rf data/openskimap/*
docker compose run tippecanoe \
  tile-join -e /data/openskimap/ /data/openskimap.mbtiles;

docker compose down

