#!/usr/bin/env node --harmony
'use strict';

const fs = require('fs-extra');
const glob = require('glob');
const path = require('path');
const pkg = require('../package.json');
const spawn = require('child_process').spawn;

const argv = require('minimist')(process.argv.slice(2), {
    boolean: ['help', 'version'],
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

    // find geojson files
    let files = glob.sync(`${scfolder}/geojson/*.geojson`);
    files.forEach(function(file) {
        let cmd = path.normalize(`${__dirname}/../node_modules/geojsonio-cli/geojsonio.js`);

        try {
            fs.statSync(file);
            const child = spawn(cmd, [file], { detached: true, stdio: 'ignore' });
            child.unref();

        } catch (err) {
            console.error(err.message);
            process.exit(1);
        }
    });

})();


function getStreetcarFolder() {
    let cwd = process.cwd();
    let folder = `${cwd}/.streetcar`;

    try {
        fs.ensureDirSync(folder);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }

    return folder;
}


function showHelp() {
    let help = `
streetcar-view

View all sequence files under .streetcar/geojson/ folder on geojson.io

Usage:
  $ streetcar-view

Options:
  --help, -h   print usage information
  --version    print version information

Example:
  $ streetcar-view

`;
    console.log(help);
}

