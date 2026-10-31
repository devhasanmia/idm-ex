param(
    [Parameter(Mandatory=$true)] [string]$videoPath,
    [Parameter(Mandatory=$true)] [string]$audioPath,
    [Parameter(Mandatory=$true)] [string]$outputPath
)

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }
    
    Function Await($WinRtTask, $ResultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($WinRtTask))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }

    Function AwaitAction($WinRtAction) {
        $asTask = [System.WindowsRuntimeSystemExtensions].GetMethod('AsTask', [Type[]]@([Windows.Foundation.IAsyncAction]))
        $netTask = $asTask.Invoke($null, @($WinRtAction))
        $netTask.Wait(-1) | Out-Null
    }

    [Windows.Media.Editing.MediaComposition, Windows.Media.Editing, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Editing.MediaClip, Windows.Media.Editing, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Editing.BackgroundAudioTrack, Windows.Media.Editing, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime] | Out-Null

    $vFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($videoPath)) ([Windows.Storage.StorageFile])
    $aFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($audioPath)) ([Windows.Storage.StorageFile])

    $clip = Await ([Windows.Media.Editing.MediaClip]::CreateFromFileAsync($vFile)) ([Windows.Media.Editing.MediaClip])
    $track = Await ([Windows.Media.Editing.BackgroundAudioTrack]::CreateFromFileAsync($aFile)) ([Windows.Media.Editing.BackgroundAudioTrack])

    $composition = [Windows.Media.Editing.MediaComposition]::new()
    $composition.Clips.Add($clip)
    $composition.BackgroundAudioTracks.Add($track)

    $outDir = Split-Path -Parent $outputPath
    $outName = Split-Path -Leaf $outputPath

    $folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($outDir)) ([Windows.Storage.StorageFolder])
    $outFile = Await ($folder.CreateFileAsync($outName, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])

    $renderOp = $composition.RenderToFileAsync($outFile)
    Await ($renderOp) ([Windows.Media.Editing.TranscodeFailureReason])

    Write-Output "SUCCESS"
} catch {
    Write-Error $_.Exception.Message
    exit 1
}

