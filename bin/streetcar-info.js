#!/usr/bin/env node
'use strict';

const bytes = require('bytes');
const fs = require('fs-extra');
const pkg = require('../package.json');
const turf = require('@turf/turf');

const argv = require('minimist')(process.argv.slice(2), {
    boolean: ['help', 'version', 'col'],
    alias: {
        h: 'help'
    }
});


(function main() {
    if (argv.version) {
        console.log(pkg.version);
        process.exit(1);
    }

    if (argv.help) {
        showHelp();
        process.exit(1);
    }

    let scfolder = getStreetcarFolder();
    let infile = `${scfolder}streetcar.geojson`;
    let gj;

    try {
        gj = fs.readJsonSync(infile);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }

    /* slug */
    let slug = gj.collectionProperties.slug;

    /* time */
    let start = new Date(+gj.collectionProperties.timeStart);
    let end = new Date(+gj.collectionProperties.timeEnd);
    let diff = Math.floor((end - start) / 1000);  // milliseconds to seconds

    /* distance */
    let front = gj.features[0];
    let miles = turf.lineDistance(front, 'miles').toFixed(2);

    /* speed */
    let mph = (miles / (diff / 3600)).toFixed(2);

    /* files */
    let files = +gj.collectionProperties.numFiles;
    let size = bytes(gj.collectionProperties.numBytes, { unitSeparator: ' ' });

    let info = new Map([
        ['Slug', slug],
        ['Date', start.toDateString()],
        ['Start', start.toTimeString()],
        ['End', end.toTimeString()],
        ['Duration', toDurationString(diff)],
        ['Distance', miles + ' mi'],
        ['Avg Speed', mph + 'mph'],
        ['Files', files + ' files'],
        ['Size', size]
    ]);

    if (argv.col) {
        console.log([...info.keys()].join('\t'));
        console.log([...info.values()].join('\t'));
    } else {
        console.log('');
        info.forEach((v,k) => console.log(`\t${k}:\t${k.length < 8 ? '\t' : ''}${v}`));
        console.log('');
    }

})();


function getStreetcarFolder() {
    let cwd = process.cwd();
    let folder = `${cwd}/.streetcar/`;

    try {
        fs.ensureDirSync(folder);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }

    return folder;
}


function toDurationString(t) {
    let d = Math.floor(t / 86400);
    let h = Math.floor(t / 3600) % 24;
    let m = Math.floor(t / 60) % 60;
    let s = t % 60;

    return (d > 0 ? `${d}d ` : '')
        + (h > 0 ? `${h}h `  : '')
        + (m > 0 ? `${m}m ` : '')
        + (s > 0 ? `${s}s` : '');
}


function showHelp() {
    let help = `
streetcar-info

Print statistics on a streetcar geojson file.
Statistics include miles and time.

Usage:
  $ streetcar-info

Options:
  --help, -h   print usage information
  --version    print version information

Example:
  $ streetcar-info

`;
    console.log(help);
}

