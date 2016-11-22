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

let cutSequenceTime = 5000;   // in milliseconds

let verbose = 1;  // 0 = quiet, 1 = normal, 2 = debug, 3 = all exif
let allfiles = {};
let alltimes = {};
let allcameras = {};
let bytes = 0;
let waitfor = 0;
let finished = false;
let cwd = process.cwd();
let scfile = '';


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
    scfile = `${scfolder}/streetcar.geojson`;

    if (verbose >= 2) {
        console.log(`cwd = ${cwd}`);
        console.log(`scfile = ${scfile}`);
    }

    // remove any existing sequence folders..
    let seqfolders = glob.sync(`${cwd}/sequence*`);
    seqfolders.forEach(function(folder) {
        try {
            fs.remove(folder);
        } catch (err) {
            if (verbose >= 1) { console.error(err.message); }
            process.exit(1);
        }
    });

    // scan the image folders..
    let imagefolders = glob.sync(`${cwd}/+(front|back|rear|left|right)`, { nocase: true });
    let foldercount = imagefolders.length;
    imagefolders.forEach(function(folder) {
        let basename = path.basename(folder);
        if (verbose >= 2) {
            console.log('');
            console.log(`---------- SCANNING ${basename} ----------`);
        }

        fs.walk(folder)
            .on('readable', function() {
                let item;
                while ((item = this.read())) {  // eslint-disable-line no-invalid-this
                    processFile(item);
                }
            })
            .on('end', function() {
                if (--foldercount === 0) {
                    finished = true;
                    if (!waitfor) {
                        finalize();
                    }
                }
            });
    });
})();


function getStreetcarFolder() {
    let folder = `${cwd}/.streetcar`;
    try {
        fs.ensureDirSync(folder);
    } catch (err) {
        if (verbose >= 1) { console.error(err.message); }
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
    if (s.indexOf('streetcar') !== -1) return null;
    if (s.indexOf('sequence') !== -1) return null;

    if (s.lastIndexOf('front') !== -1) return 'front';
    if (s.lastIndexOf('back') !== -1) return 'back';
    if (s.lastIndexOf('rear') !== -1) return 'back';
    if (s.lastIndexOf('left') !== -1) return 'left';
    if (s.lastIndexOf('right') !== -1) return 'right';
    return null;
}


function processFile(item) {
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
    waitfor++;

    exif.read(item.path)
        .then(data => {
            let basename = path.basename(item.path);
            bytes += item.stats.size;

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
            allfiles[item.path].data = copy;

            let t = imageTime.getTime();
            if (!alltimes[t]) {
                alltimes[t] = {};
            }
            alltimes[t][camera] = item.path;

            if (verbose === 2) {
                let gps = copy.gps;
                let gpsdebug = 'missing!';
                if (gps) {
                    gpsdebug = `[${gps.GPSLongitude} ${gps.GPSLongitudeRef}, ${gps.GPSLatitude} ${gps.GPSLatitudeRef}]`;
                }
                console.log(`${basename}:  camera = ${camera}, time = ${t}, gps = ${gpsdebug}`);
            }
            else if (verbose >= 3) {
                console.log(`---------- ${basename} ----------`);
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
    processData();
    if (verbose >= 1 && process.stdout.isTTY) {
        process.stdout.write('\n', () => {
            console.log(Object.keys(allfiles).length + ' file(s)');
        });
    }
}


function processData() {
    let times = Object.keys(alltimes).sort();
    let cameras = Object.keys(allcameras);
    let features = [];
    let sequences = [];
    let tPrevious = 0;


    // 1. cut into sequences
    if (verbose >= 2) {
        console.log('');
        console.log('---------- CUT INTO SEQUENCES ----------');
    }

    for (let t = 0; t < times.length; t++) {
        let tNow = +times[t];
        let sequence;

        if (tNow - tPrevious >= cutSequenceTime) {
            if (verbose >= 2) {
                let tDiff = (tNow - tPrevious) / 1000;
                console.log(`tNow = ${tNow}, tPrevious = ${tPrevious}, ${tDiff} second gap - starting new sequence`);
            }
            sequence = {};   // start a new sequence
            sequences.push(sequence);
        } else {
            sequence = sequences[sequences.length - 1];
        }


        for (let c = 0; c < cameras.length; c++) {
            let camera = cameras[c];

            let file = alltimes[tNow][camera];
            if (!file) continue;

            let data = extractExif(allfiles[file].data);
            let coord = data.coord;

            // No valid coordinates found from any camera at this time.
            // This could happen if the driver went through a tunnel or something.
            // In this case, just skip this time.
            if (!Array.isArray(coord) || coord.length < 2) {
                coord = undefined;
                //warning
            }

            if (!sequence[camera]) {
                sequence[camera] = {
                    meta: {},
                    times: {}
                };
            }

            sequence[camera].times[tNow] = {
                coord: coord,
                file: file
            };

            setCameraMetadata(sequence[camera].meta, data);
        }

        tPrevious = tNow;
    }


    // 2. Process each sequence.
    if (verbose >= 2) {
        console.log('');
        console.log('---------- PROCESS SEQUENCES ----------');
    }

    for (let s = 0; s < sequences.length; s++) {
        let sequence = sequences[s];

        if (verbose >= 2) { console.log(`sequence${s}`); }

        for (let c = 0; c < cameras.length; c++) {
            let camera = cameras[c];
            let sequenceCamera = sequence[camera];
            if (!sequenceCamera) continue;

            let seqTimes = Object.keys(sequenceCamera.times).sort();
            let coords = [];
            for (let t = 0; t < seqTimes.length - 1; t++) {
                let seqTime = seqTimes[t];

                // 2.1. Symlink the original images into a sequence folder..
                let imageFile = sequenceCamera.times[seqTime].file;
                let pathArr = imageFile.split(path.sep);
                let basename = pathArr[pathArr.length - 1];
                let container = pathArr[pathArr.length - 2];
                let linkFile = `${cwd}/sequence${s}/${camera}/${container}/${basename}`;

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
                    (camera === 'back') ? 180 :
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
    }

    // 3. export all featues..
    let dstart = new Date(+times[0]);

    let collectionProperties = {
        generator: pkg.name,
        version: pkg.version,
        source: cwd,
        slug: getSlugDate(dstart) + '-' + getSlug(),
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

    fs.writeJson(scfile, gj, function(err) {
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

        if (gps.hasOwnProperty('GPSAltitude')) {
            newObj.coord.push(gps.GPSAltitude);
        }

        if (gps.hasOwnProperty('GPSSpeed')) {
            newObj.speed = gps.GPSSpeed;
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

