#!/usr/bin/env node
'use strict';

const fs = require('fs-extra');
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
    let infile = path.normalize(`${scfolder}streetcar.geojson`);
    let cmd = path.normalize(`${__dirname}/../node_modules/geojsonio-cli/geojsonio.js`);

    try {
        fs.statSync(infile);
        const child = spawn(cmd, [infile], { detached: true, stdio: 'ignore' });
        child.unref();

    } catch (err) {
        console.error(err.message);
        process.exit(1);
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


function showHelp() {
    let help = `
streetcar-view

View a streetcar file on geojson.io

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

