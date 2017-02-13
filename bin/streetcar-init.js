#!/usr/bin/env node
'use strict';

const dms2dec = require('dms2dec');
const exif = require('fast-exif');
const fs = require('fs-extra');
const glob = require('glob');
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

let cutSequenceTime = 5;   // in seconds
let minSpeed = 5;          // in km/h

let verbose = 1;  // 0 = quiet, 1 = normal, 2 = debug, 3 = all exif
let allfiles = {};
let alltimes = {};
let allcameras = {};
let waitfor = 0;
let counter = 0;
let finished = false;
let cwd = process.cwd();
let scfolder = `${cwd}/.streetcar`;


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

    // look for the image folders..
    let imagefolders = glob.sync(`${cwd}/+(front|back|rear|left|right)`, { nocase: true });
    let foldercount = imagefolders.length;
    if (!foldercount) {
        if (verbose >= 1) { console.error('No image folders found.  Expected "front", "back", etc.'); }
        process.exit(1);
    }

    // remove contents of .streetcar folder, create if needed..
    try {
        fs.emptyDirSync(scfolder);
    } catch (err) {
        if (verbose >= 1) { console.error(err.message); }
        process.exit(1);
    }

    let noHiddenFiles = function(item){
        let basename = path.basename(item);
        return basename === '.' || basename[0] !== '.';
    };

    // scan the image folders..
    imagefolders.forEach(function(folder) {
        let basename = path.basename(folder);
        if (verbose >= 1) { console.log(`Found ${basename}`); }

        fs.walk(folder, { filter: noHiddenFiles })
            .on('readable', function() {
                let item;
                while ((item = this.read())) {  // eslint-disable-line no-invalid-this
                    processFile(item, basename);
                }
            })
            .on('end', function() {
                if (--foldercount === 0) {
                    finished = true;
                    if (!waitfor) {
                        doneFiles();
                    }
                }
            });
    });
})();


function getSlug(slugDate) {
    let dateStr = '' + slugDate.getUTCFullYear() + '_' +
            ('0' + (slugDate.getUTCMonth() + 1)).slice(-2) + '_' +
            ('0' + slugDate.getUTCDate()).slice(-2);

    let nameStr = path.basename(cwd);
    if (nameStr === '') {
        if (verbose >= 1) { console.error('No folder name.  Did you run this in the root folder?'); }
        process.exit(1);
    }

    let matches = nameStr.match(/^[^A-Za-z]*(.*)$/);  // capture where letters start
    if (matches && matches[1]) {
        nameStr = matches[1];
    }

    nameStr = nameStr.toLowerCase();

    return dateStr + '-' + nameStr;
}


function processFile(item, camera) {
    if (!item.stats.isFile()) return;
    if (!camera) return;

    if (!allcameras[camera]) {
        allcameras[camera] = camera;
    }

    waitfor++;

    exif.read(item.path)
        .then(data => {
            let basename = path.basename(item.path);

            if (!data || !Object.keys(data).length || !data.exif) {
                if (verbose >= 2) { console.log(`${basename}:  No exif!`); }
                return;
            }

            let imageTime = data.exif.DateTimeOriginal || data.exif.DateTimeDigitized;
            if (!imageTime || typeof imageTime.getTime !== 'function') {
                if (verbose >= 2) { console.log(`${basename}:  No datetime!`); }
                return;
            }

            let copy = deepCopy(data);

            allfiles[item.path] = {
                basename: basename,
                camera: camera,
                data: copy,
                bytes: item.stats.size
            };

            if (verbose === 2) {
                let padcamera = ('     ' + camera).slice(-5);
                let gpsdebug = copy.gps ? 'YES' : 'NO ';
                console.log(`${basename}:  camera = ${padcamera}, gps = ${gpsdebug}`);
            }
            else if (verbose >= 3) {
                console.log(`---------- ${basename} ----------`);
                console.log(JSON.stringify(copy, null, 2));
            }
        })
        .finally(() => {
            if (!--waitfor && finished) {
                doneFiles();
            }
        });

    if (verbose === 1 && process.stdout.isTTY) {
        if (++counter % 100 === 0) {
            process.stdout.write('.');
        }
    }
}


function doneFiles() {
    processTimes();
    if (verbose >= 1 && process.stdout.isTTY) {
        process.stdout.write('\n', () => {
            console.log(Object.keys(allfiles).length + ' file(s)');
        });
    }
}


function processTimes() {
    if (verbose >= 1 && process.stdout.isTTY) {
        process.stdout.write('\n');
        console.log('Normalizing times');
    }


    let files = Object.keys(allfiles).sort();
    for (let i = 0; i < files.length; i++) {
        let key = files[i];
        let file = allfiles[key];
        let data = file.data;
        let camera = file.camera;

        let imageTime = data.exif.DateTimeOriginal || data.exif.DateTimeDigitized;

        // Try to adjust original times to UTC..
        let tzoffset = '-8:00'.split(':').map(Number);  // hardcode PST for now
        // let tzoffset = '-5:00'.split(':').map(Number);  // hardcode EDT for now
        if (Array.isArray(tzoffset) && tzoffset.length === 2) {
            imageTime = new Date(imageTime.getTime() -
                (tzoffset[0] * 60 * 60 * 1000) -
                (tzoffset[1] * 60 * 1000 * Math.sign(tzoffset[0]))
            );
        }
        let origTime = imageTime.getTime();

        // But prefer GPS time if we have it..
        let gps = data.gps;
        // if (gps) {
        //     if (gps.hasOwnProperty('GPSDateStamp')) {
        //         let gpsdate = gps.GPSDateStamp.split(':').map(Number);
        //         if (Array.isArray(gpsdate) && gpsdate.length === 3) {
        //             imageTime.setUTCFullYear(gpsdate[0], gpsdate[1]-1, gpsdate[2]);
        //         }
        //     }
        //     if (gps.hasOwnProperty('GPSTimeStamp')) {
        //         let gpstime = gps.GPSTimeStamp.map(Number);
        //         if (Array.isArray(gpstime) && gpstime.length === 3) {
        //             imageTime.setUTCHours(gpstime[0], gpstime[1], gpstime[2]);
        //         }
        //     }
        // }

        let time = imageTime.getTime();
        if (!alltimes[time]) {
            alltimes[time] = {};
        }


        // terrible hack to avoid issue with duplicate timestamps (see #5).
        // this time-camera combination already has an image set for it.
        let tKey = time;
        if (alltimes[tKey].hasOwnProperty(camera)) {
            if (!alltimes[tKey - 1000]) { alltimes[tKey - 1000] = {}; }
            if (!alltimes[tKey - 1000].hasOwnProperty(camera)) {
console.log(`    oh no ${tKey} already has a ${camera} - lets move that one to ${tKey - 1000}`);
                // store existing image back one second in a free slot
                alltimes[tKey - 1000][camera] = alltimes[tKey][camera];
            } else {
console.log(`    uh oh ${tKey} already has a ${camera} - lets put this one at ${tKey + 1000}`);
                // store new image ahead one second and hope times fix themselves later
                tKey = tKey + 1000;
                alltimes[tKey] = {};
            }
        }

        alltimes[tKey][camera] = key;
    }

    processSequences();
}



function processSequences() {
    let times = Object.keys(alltimes).sort();
    let cameras = Object.keys(allcameras);

    // 1. split into sequences
    if (verbose >= 1) { console.log('Creating sequences'); }

    let tPrev = 0;
    let sequences = [];

    for (let t = 0; t < times.length; t++) {
        let tCurr = +times[t];
        let sequence;

        if (tCurr - tPrev >= cutSequenceTime * 1000) {
            if (verbose >= 2) {
                let tDiff = (tCurr - tPrev) / 1000;
                console.log('------------------------------');
                console.log(`tCurr = ${tCurr}, tPrev = ${tPrev}, ${tDiff} second gap - starting new sequence`);
            }
            sequence = {};   // start a new sequence
            sequences.push(sequence);
        } else {
            sequence = sequences[sequences.length - 1];
        }

        for (let c = 0; c < cameras.length; c++) {
            let camera = cameras[c];

            let file = alltimes[tCurr][camera];
            if (!file) continue;

            let data = extractExif(allfiles[file].data);
            let bytes = allfiles[file].bytes;
            let coord = data.coord;

            if (!Array.isArray(coord) || coord.length < 2) {
                // TODO: warning
                coord = undefined;
            }

            let speed = data.speed;
            if (!data.hasOwnProperty('speed')) {
                // TODO: warning
                speed = undefined;
            }


            if (!sequence[camera]) {
                sequence[camera] = {
                    meta: {},
                    bytes: 0,
                    times: {}
                };
            }

            setCameraMetadata(sequence[camera].meta, data);
            sequence[camera].bytes += bytes;
            sequence[camera].times[tCurr] = {
                coord: coord,
                speed: speed,
                file: file
            };
        }


        if (verbose >= 2) {
            let debug = '';
            for (let c = 0; c < cameras.length; c++) {
                let camera = cameras[c];
                if (sequence[camera] && sequence[camera].times[tCurr]) {
                    let file = sequence[camera].times[tCurr].file;
                    let speed = sequence[camera].times[tCurr].speed;
                    let padspeed, underspeed;

                    if (Number.isFinite(speed)) {
                        padspeed = ('     ' + speed.toFixed(1)).slice(-5);
                        underspeed = speed < minSpeed ? '↓' : ' ';
                    } else {
                        padspeed = ' null';
                        underspeed = ' ';
                    }
                    let basename = path.basename(file);
                    debug += `${camera}/${basename} ${padspeed}${underspeed} `;
                } else {
                    debug += Array(camera.length + 22).join(' ');  // pad spaces
                }
            }
            console.log(`${tCurr}:  ${debug}`);
        }


        tPrev = tCurr;
    }


    // 2. Process each sequence.
    for (let s = 0; s < sequences.length; s++) {
        let sequence = sequences[s];
        let features = [];
        let seqTimeStart = 0;
        let seqTimeEnd = 0;
        let seqFiles = 0;
        let seqBytes = 0;

        if (verbose >= 1) { console.log(`Processing sequence${s}`); }

        for (let c = 0; c < cameras.length; c++) {
            let camera = cameras[c];
            let sequenceCamera = sequence[camera];
            if (!sequenceCamera) continue;

            if (verbose >= 1) { console.log(`  ${camera}`); }
            seqBytes += sequenceCamera.bytes;

            let seqTimes = Object.keys(sequenceCamera.times).sort();
            let coords = [];
            for (let t = 0; t < seqTimes.length; t++) {
                let seqTime = +seqTimes[t];

                // skip this image if the speed is too low (driver stopped)..
                let speed = sequenceCamera.times[seqTime].speed;
                if (Number.isFinite(speed) && speed < minSpeed) continue;

                if (seqTimeStart === 0 || seqTime < seqTimeStart) {
                    seqTimeStart = seqTime;
                }
                if (seqTime > seqTimeEnd) {
                    seqTimeEnd = seqTime;
                }

                // 2.1. Symlink the original images into a sequence folder..
                seqFiles++;
                let imageFile = sequenceCamera.times[seqTime].file;
                let pathArr = imageFile.split(path.sep);
                let basename = pathArr[pathArr.length - 1];
                let container = pathArr[pathArr.length - 2];
                let linkFile = `${scfolder}/sequence/${s}/${camera}/${container}/${basename}`;

                try {
                    fs.ensureSymlinkSync(imageFile, linkFile);
                } catch (err) {
                    if (verbose >= 1) { console.error(err.message); }
                    process.exit(1);
                }

                // 2.2.  Collect the coordinates..
                let coord = sequenceCamera.times[seqTime].coord;
                if (coord) {
                    coords.push(coord);
                }
            }


            // 2.3.  If there are coordinates, generate a GeoJSON feature.
            if (coords.length) {
                let meta = sequenceCamera.meta;
                let cameraAngle =
                    (camera === 'right') ? 90 :
                    (camera === 'back' || camera === 'rear') ? 180 :
                    (camera === 'left') ? 270 : 0;

                let featureProperties = {
                    camera: camera,
                    cameraAngle: cameraAngle,
                    make: meta.make,
                    model: meta.model,
                    dimensions: [meta.dimX, meta.dimY]
                };

                let feature = {
                    id: camera,
                    type: 'Feature',
                    bbox: [meta.minX, meta.minY, meta.maxX, meta.maxY],
                    properties: featureProperties,
                    geometry: {
                        type: 'LineString',
                        coordinates: coords
                    }
                };

                features.push(feature);
            }
        }

        // 3. export GeoJSON..
        let dateStart = new Date(+times[0]);
        let slug = getSlug(dateStart);

        let collectionProperties = {
            generator: pkg.name,
            version: pkg.version,
            slug: slug,
            sequence: `sequence${s}`,
            numFiles: seqFiles,
            numBytes: seqBytes,
            timeStart: seqTimeStart,
            timeEnd: seqTimeEnd
        };

        let gj = {
            type: 'FeatureCollection',
            collectionProperties: collectionProperties,
            features: features
        };

        let geojsonFile = `${scfolder}/geojson/${s}.geojson`;
        if (verbose >= 2) { console.log(`  writing .streetcar/geojson/${s}.geojson`); }
        try {
            fs.ensureFileSync(geojsonFile);
            fs.writeJsonSync(geojsonFile, gj);
        } catch (err) {
            if (verbose >= 1) { console.error(err.message); }
            process.exit(1);
        }

    }
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
    if (gps && hasAllProperties(gps, props)) {          // conver dms to [lng, lat]
        newObj.coord = dms2dec(
            gps.GPSLatitude, gps.GPSLatitudeRef,
            gps.GPSLongitude, gps.GPSLongitudeRef
        ).reverse();

        if (gps.hasOwnProperty('GPSAltitude')) {        // expect meters
            let altitude = Number.parseFloat(gps.GPSAltitude);
            if (Number.isFinite(altitude)) {
                newObj.coord.push(gps.GPSAltitude);
            }
        }

        props = ['GPSSpeed', 'GPSSpeedRef'];
        if (hasAllProperties(gps, props)) {
            let speed = Number.parseFloat(gps.GPSSpeed);
            if (Number.isFinite(speed)) {
                if (gps.GPSSpeedRef === 'K') {          // keep as kph
                    newObj.speed = speed;
                } else if (gps.GPSSpeedRef === 'M') {   // convert mph to kph
                    newObj.speed = speed * 1.60934;
                } else if (gps.GPSSpeedRef === 'N') {   // convert knots to kph
                    newObj.speed = speed * 1.852;
                }
            }
        }
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


function setCameraMetadata(dst, src) {
    if (dst.make === undefined && src.Make)
        dst.make = src.Make;
    if (dst.model === undefined && src.Model)
        dst.model = src.Model;
    if (dst.dimX === undefined && src.PixelXDimension)
        dst.dimX = src.PixelXDimension;
    if (dst.dimY === undefined && src.PixelYDimension)
        dst.dimY = src.PixelYDimension;

    let coord = src.coord;
    if (!Array.isArray(coord) || coord.length < 2) return;

    if (dst.minX === undefined || coord[0] < dst.minX)
        dst.minX = coord[0];
    if (dst.minY === undefined || coord[1] < dst.minY)
        dst.minY = coord[1];
    if (dst.maxX === undefined || coord[0] > dst.maxX)
        dst.maxX = coord[0];
    if (dst.maxY === undefined || coord[1] > dst.maxY)
        dst.maxY = coord[1];
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
    } else if (typeof obj !== 'object' || Array.isArray(obj) || obj instanceof Date) {
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
4. Split into sequences (a gap of >5sec starts a new sequence)
5. Create sequence folders under .streeetcar/sequence/N
6. Symlink the image files into the appropriate sequence folder
7. Generate GeoJSON files for each sequence under .streetcar/geojson/
   with the image coordinates as a LineString

Usage:
  $ streetcar-init

Options:
  --help, -h           print usage information
  --version            print version information
  --verbose, -v [val]  specify verbosity (0 = quiet, 1 = normal, 2 = verbose, 3 = all exif)
  --quiet, -q          no output (same as --verbosity 0)

Example:
  $ streetcar-init

  Sequences will be generated in: .streetcar/sequence/N/
  GeoJSONs will be generated in: .streetcar/geojson/N.geojson

`;
    console.log(help);
}

