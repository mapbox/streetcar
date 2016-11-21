#!/usr/bin/env node
'use strict';

const dms2dec = require('dms2dec');
const exif = require('fast-exif');
const fs = require('fs-extra');
const path = require('path');
const pkg = require('../package.json');

const argv = require('minimist')(process.argv.slice(2), {
    boolean: ['help', 'quiet', 'version'],
    alias: {
        h: 'help',
        v: 'verbose',
        q: 'quiet'
    },
    default: {
        verbose: 1
    },
});


let verbose = 1;  // 0 = quiet, 1 = normal, 2 = debug, 3 = all exif
let allfiles = {};
let alltimes = {};
let allcameras = {};
let bytes = 0;
let waitfor = 0;
let finished = false;
let cwd = process.cwd();
let outfile = '';
let slug = '';


(function main() {
    if (argv.version) {
        console.log(pkg.version);
        process.exit(1);
    }

    if (argv.help) {
        showHelp();
        process.exit(1);
    }

    verbose = argv.verbose;
    if (argv.quiet) {
        verbose = 0;
    }


    let scfolder = getStreetcarFolder();
    outfile = `${scfolder}streetcar.geojson`;
    slug = getSlug();

    if (verbose >= 2) {
        console.log(`cwd = ${cwd}`);
        console.log(`slug = ${slug}`);
        console.log(`outfile  = ${outfile}`);
    }

    fs.walk(cwd)
        .on('readable', function() {
            let item;
            while ((item = this.read())) {
                processItem(item);
            }
        })
        .on('end', function() {
            finished = true;
            if (!waitfor) {
                finalize();
            }
        });
})();


function getStreetcarFolder() {
    let folder = `${cwd}/.streetcar/`;

    try {
        fs.ensureDirSync(folder);
    } catch (err) {
        if (verbose >= 1) {
            console.error(err.message);
        }
        process.exit(1);
    }

    return folder;
}


function getSlug() {
    let pathArr = cwd.split(path.sep);
    let slug = '';

    while (slug === '' && pathArr.length) {
        slug = pathArr.pop();
    }

    if (slug === '') {
        if (verbose >= 1) {
            console.error('No folder name.  Did you run this in the root folder?');
        }
        process.exit(1);
    }

    let matches = slug.match(/^[^A-Za-z]*(.*)$/);  // capture where letters start
    if (matches && matches[1]) {
        slug = matches[1];
    }

    slug = slug.toLowerCase();
    return slug;
}


function getSlugDate(d) {
    return '' + d.getUTCFullYear() + '_' +
        ('0' + (d.getUTCMonth() + 1)).slice(-2) + '_' +
        ('0' + d.getUTCDate()).slice(-2);
}


function getCamera(filepath) {
    let s = filepath.toLowerCase();
    if (s.lastIndexOf('front') !== -1) return 'front';
    if (s.lastIndexOf('back') !== -1) return 'back';
    if (s.lastIndexOf('rear') !== -1) return 'back';
    if (s.lastIndexOf('left') !== -1) return 'left';
    if (s.lastIndexOf('right') !== -1) return 'right';
    return null;
}


function processItem(item) {
    if (!item.stats.isFile()) return;

    let camera = getCamera(item.path);
    if (!camera) return;

    if (!allcameras[camera]) {
        if (verbose >= 2) {
            console.log(`Found ${camera} camera`);
        }
        allcameras[camera] = camera;
    }

    allfiles[item.path] = {};
    bytes += item.stats.size;
    waitfor++;

    exif.read(item.path)
        .then(data => {
            if (verbose >= 2) {
                console.log('---------- ' + path.basename(item.path) + ' ----------');
            }

            if (!data || !Object.keys(data).length || !data.exif) {
                if (verbose >= 2) { console.log('No exif!'); }
                return;
            }

            let imageTime = data.exif.DateTimeOriginal || data.exif.DateTimeDigitized;
            if (!imageTime || typeof imageTime.getTime !== 'function') {
                if (verbose >= 2) { console.log('No datetime!'); }
                return;
            }

            let copy = deepCopy(data);
            allfiles[item.path].data = copy;

            let t = imageTime.getTime();
            if (!alltimes[t]) {
                alltimes[t] = {};
            }
            alltimes[t][camera] = item.path;

            if (verbose >= 3) {
                console.log(JSON.stringify(copy, null, 2));
            }
        })
        .finally(() => {
            if (!--waitfor && finished) {
                finalize();
            }
        });

    if (verbose === 1 && process.stdout.isTTY) {
        process.stdout.write('.');
    }
}


function finalize() {
    exportGeoJSON(outfile);
    if (verbose >= 1 && process.stdout.isTTY) {
        process.stdout.write('\n', () => {
            console.log(Object.keys(allfiles).length + ' file(s)');
        });
    }
}


function exportGeoJSON(file) {
    let times = Object.keys(alltimes).sort();
    let cameras = Object.keys(allcameras);
    let features = [];
    let dstart = new Date(+times[0]);

    for (let i = 0; i < cameras.length; i++) {
        let camera = cameras[i];
        let coords = [];
        let coordProperties = { times: [] };
        let make, model, dimX, dimY, minX, minY, maxX, maxY;

        let cameraAngle =
            (camera === 'right') ? 90 :
            (camera === 'back') ? 180 :
            (camera === 'left') ? 270 : 0;

        for (let j = 0; j < times.length; j++) {
            let time = times[j];
            let file = alltimes[time][camera];
            if (!file) continue;

            let data = extractExif(allfiles[file].data);
            let coord = data.coord;

            // Missing gps coordinates.
            // Try to grab coordinates from another camera at same time.
            if (!Array.isArray(coord) || coord.length < 2) {
                for (let k = 0; k < cameras.length; k++) {
                    if (k === i) continue;
                    let cameraAlt = cameras[k];
                    let fileAlt = alltimes[time][cameraAlt];
                    if (!fileAlt) continue;

                    let dataAlt = extractExif(allfiles[fileAlt].data);
                    let coordAlt = dataAlt.coord;
                    if (!Array.isArray(coordAlt) || coordAlt.length < 2) {
                        continue;
                    }

                    // offset slightly so they don't appear coincident
                    coord = coordAlt.map(c => c + 0.000001);
                    break;
                }
            }

            // No valid coordinates found from any camera at this time.
            // This could happen if the driver went through a tunnel or something.
            // In this case, just skip this time.
            if (!Array.isArray(coord) || coord.length < 2) {
                continue;
            }

            coords.push(coord);
            coordProperties.times.push(time);

            if (make === undefined && data.Make)
                make = data.Make;
            if (model === undefined && data.Model)
                model = data.Model;
            if (dimX === undefined && data.PixelXDimension)
                dimX = data.PixelXDimension;
            if (dimY === undefined && data.PixelYDimension)
                dimY = data.PixelYDimension;
            if (minX === undefined || coord[0] < minX)
                minX = coord[0];
            if (minY === undefined || coord[1] < minY)
                minY = coord[1];
            if (maxX === undefined || coord[0] > maxX)
                maxX = coord[0];
            if (maxY === undefined || coord[1] > maxY)
                maxY = coord[1];
        }

        let featureProperties = {
            camera: camera,
            cameraAngle: cameraAngle,
            make: make,
            model: model,
            dimensions: [dimX, dimY],
            coordinateProperties: coordProperties
        };

        let feature = {
            id: camera,
            type: 'Feature',
            bbox: [minX, minY, maxX, maxY],
            properties: featureProperties,
            geometry: {
                type: 'LineString',
                coordinates: coords
            }
        };

        features.push(feature);
    }


    let collectionProperties = {
        generator: pkg.name,
        version: pkg.version,
        source: cwd,
        slug: getSlugDate(dstart) + '-' + slug,
        numFiles: Object.keys(allfiles).length,
        numBytes: bytes,
        timeStart: times[0],
        timeEnd: times[times.length - 1]
    };

    let gj = {
        type: 'FeatureCollection',
        collectionProperties: collectionProperties,
        features: features
    };

    fs.writeJson(file, gj, function(err) {
        if (err) {
            console.log('Write error: ' + err);
        }
    });
}


// Get the exif data we are interested in
function extractExif(obj) {
    let newObj = {};
    let props = [];

    let image = obj.image;
    props = ['Make', 'Model'];
    if (image && hasAllProperties(image, props)) {
        newObj.Make = image.Make;
        newObj.Model = image.Model;
    }

    let exif = obj.exif;
    props = ['PixelXDimension', 'PixelYDimension'];
    if (exif && hasAllProperties(exif, props)) {
        newObj.PixelXDimension = exif.PixelXDimension;
        newObj.PixelYDimension = exif.PixelYDimension;
    }

    let gps = obj.gps;
    props = ['GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'];
    if (gps && hasAllProperties(gps, props)) {
        newObj.coord = dms2dec(
            gps.GPSLatitude, gps.GPSLatitudeRef,
            gps.GPSLongitude, gps.GPSLongitudeRef
        ).reverse();
    }

    return newObj;


    function hasAllProperties(obj, props) {
        for (let prop of props) {
            if (!obj.hasOwnProperty(prop))
                return false;
        }
        return true;
    }
}


// Make a readable copy of the exif data for debugging, removing ArrayBuffers
function deepCopy(obj, withBuffers) {
    if (ArrayBuffer.isView(obj)) {
        if (withBuffers) {
            return obj;
        } else {
            return {  // debugging info only
                type: 'Buffer',
                data: obj.byteLength > 16 ? ['...'] : new Uint8Array(obj),
                length: obj.byteLength
            };
        }
    }
    else if (typeof obj !== 'object' || Array.isArray(obj)) {
        return obj;
    }

    let newObj = {};
    for (let key in obj) {
        newObj[key] = deepCopy(obj[key]);
    }

    return newObj;
}



function showHelp() {
    let help = `
streetcar-init

This program will:
1. Create a .streetcar/ folder if it does not already exist
2. Find image files recursively in and below the current folder
3. Parse EXIF data from the image files to gather capture times and GPS coordinates.
4. Generate a GeoJSON file with the resulting coordinates as a LineString

Usage:
  $ streetcar-init

Options:
  --help, -h           print usage information
  --version            print version information
  --verbose, -v [val]  specify verbosity (0 = quiet, 1 = normal, 2 = verbose, 3 = all exif)
  --quiet, -q          no output (same as --verbosity 0)

Example:
  $ streetcar-init

  GeoJSON will be generated in: .streetcar/streetcar.geojson

`;
    console.log(help);
}

