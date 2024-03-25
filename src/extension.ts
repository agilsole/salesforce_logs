import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import * as fs from 'fs';

// structure of a log object
interface Log {
    Id: string;
    Application: string;
    Operation: string;
    StartTime: string;
    Status: string;
    LogUser?: { Name: string }; 
    LogLength: string;
}


// Called when the extension is activated
export async function activate(context: vscode.ExtensionContext) {

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    statusBarItem.text = '$(globe)'; // Icon for the status bar
    statusBarItem.tooltip = 'AG:Analyzer';
    statusBarItem.command = 'extension.showSalesforceLogs';
    statusBarItem.show();

    let disposable = vscode.commands.registerCommand('extension.showSalesforceLogs', async () => {
        // Show loading notification
        const loadingMessage = vscode.window.setStatusBarMessage('Loading Salesforce logs...');
      
        try {
            // Retrieve logs from Salesforce using sfdx connection
            const logs = await retrieveLogs(context);
    
            // Dismiss loading notification status bar
            loadingMessage.dispose();
    
            //Enviar los logs al HTML
            sendLogsToWebview(context, logs);

        } catch (error) {

            loadingMessage.dispose();
    
            // Show error in the panel
            const errorMessage = typeof error === 'string' ? error : String(error);
            vscode.window.showInformationMessage(errorMessage);
        }
        
    });
    context.subscriptions.push(disposable);
}


// Function to retrieve Salesforce logs to the datatable
async function retrieveLogs(context: vscode.ExtensionContext): Promise<any[]> {
    try {
        // Display a progress notification while retrieving logs
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Retrieving Salesforce Logs',
            cancellable: false
        }, async (progress) => {
            // Execute command to display org info
            //const orgResult = await executeCommand('sfdx force:org:display --json');

            // Execute command to retrieve logs
            const command = 'sfdx force:data:soql:query -q "SELECT Id, Application, Operation, StartTime, Status,LogUser.Name, LogLength  FROM ApexLog ORDER BY SystemModstamp desc LIMIT 20" --json';
            const result = await executeCommand(command);

            // Check if result has records property
            if (result && result.result && result.result.records) {
                return result.result.records;
            } else {
                throw new Error('No records found in the result');
            }
        });
    } catch (error) {
        throw new Error('Failed to retrieve Salesforce logs: ' + error);
    }
}

// Send logs to the webview
function sendLogsToWebview(context: vscode.ExtensionContext, logs: any[]) {
    createWebviewPanel(context, JSON.stringify(logs));
}

async function createWebviewPanel(context: vscode.ExtensionContext, logs: string) {
    const panel = vscode.window.createWebviewPanel(
        'aglogs', // Use the ID specified in package.json
        'Salesforce Logs',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    panel.webview.html = getLogsHtml(logs, context);

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

// Function to get HTML content for displaying log records
function getLogsHtml(logsJSON: string, context: vscode.ExtensionContext): string {
    try {
        const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'src/extensionAdria.html');
        const htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

        const logs: Log[] = JSON.parse(logsJSON); // Assuming errorMessage is actually logsJSON

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
        return ''; // Return empty string if error occurs
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


