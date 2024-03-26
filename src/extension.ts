import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import * as fs from 'fs';

interface Log {
    Id: string;
    Application: string;
    Operation: string;
    StartTime: string;
    Status: string;
    LogUser?: { Name: string };
    LogLength: string;
}

let intervalId: NodeJS.Timeout | undefined;
let panel: vscode.WebviewPanel | undefined;

// Called when the extension is activated
export async function activate(context: vscode.ExtensionContext) {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    statusBarItem.text = '$(output)';// Icon for the status bar
    statusBarItem.tooltip = 'AG:Analyzer';
    statusBarItem.command = 'extension.showSalesforceLogs';
    statusBarItem.show();

    let disposable = vscode.commands.registerCommand('extension.showSalesforceLogs', async () => {
        //notification en la Status Bar
        const loadingMessage = vscode.window.setStatusBarMessage('Loading Salesforce logs extension...');
      
        try {
            //Obtener los logs
            const logs = await retrieveLogs(context);
            loadingMessage.dispose();
    
            //Enviar los logs al HTML
            sendLogsToWebview(context, logs);

        } catch (error) {
            //Mostrar mensaje de error
            loadingMessage.dispose(); 
            const errorMessage = typeof error === 'string' ? error : String(error);
            vscode.window.showInformationMessage(errorMessage);
        }
        
    });

    context.subscriptions.push(disposable);
    //createOrShowWebview(context);
    startFetchingLogs(context);
}

// Function to send logs to the webview
function sendLogsToWebview(context: vscode.ExtensionContext, logs: any[]) {
    createOrShowWebview(context);
    updateWebviewContent(logs, context);
}

//Crear o mostrar el WebView 
function createOrShowWebview(context: vscode.ExtensionContext) {
    if (!panel) {
        panel = vscode.window.createWebviewPanel(
            'aglogs', // Use the ID specified in package.json
            'Salesforce Logs',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        // Handle messages sent from the webview
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'callFunction') {
                const id = message.id; // ID del LOG
                console.log('Clicked row ID:', id);

                try {
                    await retrieveFullLog(context, id);
                } catch (error) {
                    vscode.window.showErrorMessage('Failed to retrieve full log: ' + error);
                }
            }
        });

         //Si se cierra el panel se deja de obtener logs
         panel.onDidDispose(() => {
            stopFetchingLogs(); // Call method to stop fetching logs
            panel = undefined; // Reset panel reference
        });
        
    } else {
        //El panel ya existe
        panel.reveal(vscode.ViewColumn.One);
    }
}

//Parar de obtener logs periodicamentem (falta añadirlo)
function stopFetchingLogs() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = undefined;
    }
}

//Obtener logs periodicamente
function startFetchingLogs(context: vscode.ExtensionContext) {
    //Obtener logs la primera vez
    fetchAndSendLogs(context);

    //Obtener logs cada 5s
    intervalId = setInterval(() => {
        console.log('refrescando logs');
        fetchAndSendLogs(context);
    }, 5000); 
}

// Function to fetch logs and send them to the webview
async function fetchAndSendLogs(context: vscode.ExtensionContext) {
    try {
        const logs = await retrieveLogs(context);
        updateWebviewContent(logs, context); //Actualizar el html del webview
    } catch (error) {
        vscode.window.showErrorMessage('Failed to retrieve logs: ' + error);
    }
}

// Actualizar el contenido del HTML WebView con los nuevos logs
function updateWebviewContent(logs: any[], context: vscode.ExtensionContext) {
    if (panel) {
        const logsJSON = JSON.stringify(logs);
        const logsHtml = getLogsHtml(logsJSON, context);
        panel.webview.html = logsHtml;
    } else {
        console.error('Webview panel not initialized');
    }
}

// Obtener los logs de la org
async function retrieveLogs(context: vscode.ExtensionContext): Promise<any[]> {
    try {

        const command = 'sfdx force:data:soql:query -q "SELECT Id, Application, Operation, StartTime, Status,LogUser.Name, LogLength FROM ApexLog ORDER BY SystemModstamp DESC LIMIT 20" --json';
        const result = await executeCommand(command);

        // Check if result has records property
        if (result && result.result && result.result.records) {
            return result.result.records;
        } else {
            throw new Error('No hay registros para mostrar');
        }
    } catch (error) {
        throw new Error('Failed to retrieve Salesforce logs: ' + error);
    }
}

async function retrieveFullLog(context: vscode.ExtensionContext, id: string): Promise<void> {
    try {
        //CREAR CARPETA DE LOGS + FICHERO.LOG
        const outputFolder = vscode.Uri.joinPath(vscode.Uri.file(context.extensionPath), 'developerLogs');
        fs.mkdirSync(outputFolder.fsPath, { recursive: true });
        const outputFile = vscode.Uri.joinPath(outputFolder, `${id}.log`).fsPath;

        // Retrieve full log with progress notification
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Retrieving Full Log',
            cancellable: false
        }, async (progress) => {
            // Execute command to retrieve full log
            const command = `sfdx force:apex:log:get -i ${id} --json`;
            await executeCommandFile(command, outputFile);
            vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outputFile));
        });
    } catch (error) {
        throw new Error('Failed to retrieve full log: ' + error);
    }
}

// Mapear estructura de los logs al fichero html
function getLogsHtml(logsJSON: string, context: vscode.ExtensionContext): string {
    try {
        const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'src/extensionAdria.html');
        const htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

        const logs: Log[] = JSON.parse(logsJSON); 

        const logsHtml = logs.map((log: Log) => `
            <tr>
                <td>${log.Id}</td>
                <td>${log.Application}</td>
                <td>${log.Operation}</td>
                <td>${log.StartTime}</td>
                <td>${log.Status}</td>
                <td>${log.LogUser ? log.LogUser.Name : ''}</td> <!-- Access LogUser.Name if LogUser exists -->
                <td>${log.LogLength}</td>
            </tr>
        `).join('');
        return htmlContent.replace('<!--INSERTAR LOGS-->', logsHtml);

    } catch (error) {
        throw new Error('Failed to retrieve the html: ' + error);
    }
}

//EJECUTAR COMANDOS
function executeCommand(command: string): Promise<any> {
    return new Promise<any>((resolve, reject) => {
        childProcess.exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                try {
                    resolve(JSON.parse(stdout));
                } catch (parseError) {
                    reject(parseError);
                }
            }
        });
    });
}

///PARA GUARDAR FICHEROS DE LOGS 
async function executeCommandFile(command: string, outputFile: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {

        const process = childProcess.spawn(command, { shell: true });

        // Create a write stream to the output file
        const outputStream = fs.createWriteStream(outputFile);

        // Event handler for process exit
        process.on('close', (code) => {
            if (code === 0) {
                resolve(); // Resolve promise if command executes successfully
            } else {
                reject(new Error(`Command failed with code ${code}`)); // Reject with error if command fails
            }
        });

        // Event handler for process error
        process.on('error', (error) => {
            reject(error); 
        });

        process.stdout.on('data', (data) => {
            const result = JSON.parse(data);

            // Check if the debug has the expected structure
            if (result && result.result && Array.isArray(result.result) && result.result.length > 0 && result.result[0].log) {
                // Guardar la parte que queremos del log en el fichero
                outputStream.write(result.result[0].log);
            } else {
                reject(new Error('Unexpected response format')); 
            }
        });

        // Event handler for stderr data
        process.stderr.on('data', (data) => {
            console.error(data.toString()); // Log stderr output
        });
    });
}


