import http from 'http';
import config from './config';
import { Problem, CphSubmitResponse, CphEmptyResponse } from './types';
import { saveProblem } from './parser';
import * as vscode from 'vscode';
import path from 'path';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { isCodeforcesUrl, randomId } from './utils';
import {
    getDefaultLangPref,
    getLanguageId,
    useShortCodeForcesName,
    getMenuChoices,
    getDefaultLanguageTemplateFileLocation,
} from './preferences';
import { getProblemName } from './submit';
import { spawn } from 'child_process';
import { getJudgeViewProvider } from './extension';
import { words_in_text } from './utilsPure';
import fs from 'fs';
import { getEnableClassification } from './preferences';
import { format } from 'util';

const emptyResponse: CphEmptyResponse = { empty: true };
let savedResponse: CphEmptyResponse | CphSubmitResponse = emptyResponse;
const COMPANION_LOGGING = false;

export const submitKattisProblem = (problem: Problem) => {
    const srcPath = problem.srcPath;
    const homedir = require('os').homedir();
    let submitPath = `${homedir}/.kattis/submit.py`;
    if (process.platform == 'win32') {
        if (
            !existsSync(`${homedir}\\.kattis\\.kattisrc`) ||
            !existsSync(`${homedir}\\.kattis\\submit.py`)
        ) {
            vscode.window.showErrorMessage(
                `Please ensure .kattisrc and submit.py are present in ${homedir}\\.kattis\\submit.py`,
            );
            return;
        } else {
            submitPath = `${homedir}\\.kattis\\submit.py`;
        }
    } else {
        if (
            !existsSync(`${homedir}/.kattis/.kattisrc`) ||
            !existsSync(`${homedir}/.kattis/submit.py`)
        ) {
            vscode.window.showErrorMessage(
                `Please ensure .kattisrc and submit.py are present in ${homedir}/.kattis/submit.py`,
            );
            return;
        } else {
            submitPath = `${homedir}/.kattis/submit.py`;
        }
    }
    const pyshell = spawn('python', [submitPath, '-f', srcPath]);

    //tells the python script to open submission window in new tab
    pyshell.stdin.setDefaultEncoding('utf-8');
    pyshell.stdin.write('Y\n');
    pyshell.stdin.end();

    pyshell.stdout.on('data', function (data) {
        console.log(data.toString());
        getJudgeViewProvider().extensionToJudgeViewMessage({
            command: 'new-problem',
            problem,
        });
        ({ command: 'submit-finished' });
    });
    pyshell.stderr.on('data', function (data) {
        console.log(data.tostring());
        vscode.window.showErrorMessage(data);
    });
};

/** Stores a response to be submitted to CF page soon. */
export const storeSubmitProblem = (problem: Problem) => {
    const srcPath = problem.srcPath;
    const problemName = getProblemName(problem.url);
    const sourceCode = readFileSync(srcPath).toString();
    const languageId = getLanguageId(problem.srcPath);
    savedResponse = {
        empty: false,
        url: problem.url,
        problemName,
        sourceCode,
        languageId,
    };

    console.log('Stored savedResponse', savedResponse);
};

export const setupCompanionServer = () => {
    try {
        const server = http.createServer((req, res) => {
            const { headers } = req;
            let rawProblem = '';

            req.on('readable', function () {
                COMPANION_LOGGING && console.log('Companion server got data');
                const tmp = req.read();
                if (tmp && tmp != null && tmp.length > 0) {
                    rawProblem += tmp;
                }
            });
            req.on('close', function () {
                const problem: Problem = JSON.parse(rawProblem);
                handleNewProblem(problem);
                COMPANION_LOGGING &&
                    console.log('Companion server closed connection.');
            });
            res.write(JSON.stringify(savedResponse));
            if (headers['cph-submit'] == 'true') {
                COMPANION_LOGGING &&
                    console.log(
                        'Request was from the cph-submit extension; sending savedResponse and clearing it',
                        savedResponse,
                    );

                if (savedResponse.empty != true) {
                    getJudgeViewProvider().extensionToJudgeViewMessage({
                        command: 'submit-finished',
                    });
                }
                savedResponse = emptyResponse;
            }
            res.end();
        });
        server.listen(config.port);
        server.on('error', (err) => {
            vscode.window.showErrorMessage(
                `Are multiple VSCode windows open? CPH will work on the first opened window. CPH server encountered an error: "${err.message}" , companion may not work.`,
            );
        });
        console.log('Companion server listening on port', config.port);
        return server;
    } catch (e) {
        console.error('Companion server error :', e);
    }
};

export const getProblemFileName = (problem: Problem, ext: string) => {
    if (isCodeforcesUrl(new URL(problem.url)) && useShortCodeForcesName()) {
        return `${getProblemName(problem.url)}.${ext}`;
    } else {
        console.log(
            isCodeforcesUrl(new URL(problem.url)),
            useShortCodeForcesName(),
        );

        const words = words_in_text(problem.name);
        if (words === null) {
            return `${problem.name.replace(/\W+/g, '_')}.${ext}`;
        } else {
            return `${words.join('_')}.${ext}`;
        }
    }
};

export const getProblemPlatform = (problem: Problem) => {
    const platform_key = ['codeforces', 'atcoder'];
    const platform = problem.group.split('-')[0].trim().toLowerCase();
    console.log('Got platform : ' + platform);
    const idx = platform_key.indexOf(platform);
    if (idx >= 0) {
        return platform_key[idx];
    }
    return '';
};

class ProblemInfo {
    platform: string;
    type: string;
    pid: string;
    constructor(type: string, pid: string, platform: string) {
        this.type = type;
        this.pid = pid;
        this.platform = platform;
    }
}
export const getProblemInfo = (problem: Problem) => {
    const platform = getProblemPlatform(problem);
    const part = problem.url.split('/');
    let tp = "", pid = "", plf = platform;
    if (platform == 'codeforces') {
        for (let i = 0; i < part.length; i++) {
            switch (part[i]) {
                case 'contest':
                    tp = part[i];
                    pid = part[i+1];
                    plf = platform;
                    break;
                case 'problemset':
                    tp = part[i];
                    pid = part[i+2];
                    plf = platform;
                    break;
                case 'gym':
                    tp = part[i];
                    pid = part[i+1];
                    plf = platform;
                    break;
            }
        }
    } else if (platform == 'atcoder') {
        for (let i = 0; i < part.length; i++) {
            switch (part[i]) {
                case 'contests':
                    tp = part[i];
                    pid = part[i+1];
                    plf = platform;
                    break;
            }
        }
    }
    return new ProblemInfo(tp, pid, plf);
};

export const getProblemStem = (problem: Problem) => {
    const info = getProblemInfo(problem);
    const res = path.join(info.platform, info.type, info.pid);
    return res;
};

/** Handle the `problem` sent by Competitive Companion, such as showing the webview, opening an editor, managing layout etc. */
const handleNewProblem = async (problem: Problem) => {
    // If webview may be focused, close it, to prevent layout bug.
    if (vscode.window.activeTextEditor == undefined) {
        getJudgeViewProvider().extensionToJudgeViewMessage({
            command: 'new-problem',
            problem: undefined,
        });
    }
    const folder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (folder === undefined) {
        vscode.window.showInformationMessage('Please open a folder first.');
        return;
    }
    const defaultLanguage = getDefaultLangPref();
    let extn: string;

    if (defaultLanguage == null) {
        const allChoices = new Set(Object.keys(config.extensions));
        const userChoices = getMenuChoices();
        const choices = userChoices.filter((x) => allChoices.has(x));
        const selected = await vscode.window.showQuickPick(choices);
        if (!selected) {
            vscode.window.showInformationMessage(
                'Aborted creation of new file',
            );
            return;
        }
        // @ts-ignore
        extn = config.extensions[selected];
    } else {
        //@ts-ignore
        extn = config.extensions[defaultLanguage];
    }
    let url: URL;
    try {
        url = new URL(problem.url);
    } catch (err) {
        console.error(err);
        return null;
    }
    if (url.hostname == 'open.kattis.com') {
        const splitUrl = problem.url.split('/');
        problem.name = splitUrl[splitUrl.length - 1];
    }
    const problemFileName = getProblemFileName(problem, extn);
    let srcPath_;
    if (getEnableClassification()) {
        const stem = getProblemStem(problem);
        const dir = path.join(folder, stem);
        srcPath_ = path.join(folder, stem, problemFileName);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    } else {
        srcPath_ = path.join(folder, problemFileName);
    }
    const srcPath = srcPath_;
    // Add fields absent in competitive companion.
    problem.srcPath = srcPath;
    problem.tests = problem.tests.map((testcase) => ({
        ...testcase,
        id: randomId(),
    }));
    if (!existsSync(srcPath)) {
        writeFileSync(srcPath, '');
    }
    saveProblem(srcPath, problem);
    const doc = await vscode.workspace.openTextDocument(srcPath);

    if (defaultLanguage) {
        const templateLocation = getDefaultLanguageTemplateFileLocation();
        if (templateLocation !== null) {
            const templateExists = existsSync(templateLocation);
            if (!templateExists) {
                vscode.window.showErrorMessage(
                    `Template file does not exist: ${templateLocation}`,
                );
            } else {
                const templateContents = readFileSync(
                    templateLocation,
                ).toString();
                writeFileSync(srcPath, templateContents);
            }
        }
    }

    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    getJudgeViewProvider().extensionToJudgeViewMessage({
        command: 'new-problem',
        problem,
    });
};
