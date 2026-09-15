# 一键部署（Windows PowerShell / pwsh）
#
#   .\deploy\up.ps1
#
# 行为与 deploy/up.sh 一致：首次运行生成 deploy/.env（含随机密钥与随机管理员密码），
# 然后构建并后台启动全套服务。重复执行等价于重新构建 + 滚动更新。

$ErrorActionPreference = 'Stop'

# 切到仓库根目录（脚本在 deploy/ 下）
Set-Location (Join-Path $PSScriptRoot '..')

$envFile = 'deploy/.env'
$template = 'deploy/env.example'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error '[up] 未找到 docker。请先安装 Docker Desktop 并确保其已启动。'
}

function New-RandomString([int]$length) {
    $alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    -join (1..$length | ForEach-Object { $alphabet[(Get-Random -Maximum $alphabet.Length)] })
}

$firstRun = $false
if (-not (Test-Path $envFile)) {
    if (-not (Test-Path $template)) { Write-Error "[up] 模板文件 $template 缺失" }

    Write-Host "[up] 未找到 $envFile，正在从模板生成（随机密钥 + 随机管理员密码）..."
    $adminPassword = New-RandomString 16
    $lines = Get-Content $template -Encoding utf8 | ForEach-Object {
        switch -Regex ($_) {
            '^MYSQL_ROOT_PASSWORD=' { "MYSQL_ROOT_PASSWORD=$(New-RandomString 32)" }
            '^JWT_ACCESS_SECRET=' { "JWT_ACCESS_SECRET=$(New-RandomString 48)" }
            '^JWT_REFRESH_SECRET=' { "JWT_REFRESH_SECRET=$(New-RandomString 48)" }
            '^SEED_ADMIN_PASSWORD=' { "SEED_ADMIN_PASSWORD=$adminPassword" }
            default { $_ }
        }
    }
    # 无 BOM 的 UTF-8：compose 读到 BOM 会把第一个变量名读歪
    [System.IO.File]::WriteAllLines(
        (Resolve-Path -LiteralPath '.').Path + '\deploy\.env',
        $lines,
        (New-Object System.Text.UTF8Encoding($false))
    )
    $firstRun = $true
}
else {
    Write-Host "[up] 复用已有的 $envFile"
}

Write-Host '[up] 构建并启动（首次构建需要几分钟）...'
docker compose --env-file $envFile up -d --build

$webPort = (Select-String -Path $envFile -Pattern '^WEB_PORT=' | Select-Object -First 1) -replace '^WEB_PORT=', ''
if (-not $webPort) { $webPort = '80' }

Write-Host ''
Write-Host '──────────────────────────────────────────────────────────────'
if ($firstRun) {
    $adminPw = (Select-String -Path $envFile -Pattern '^SEED_ADMIN_PASSWORD=' | Select-Object -First 1) -replace '^SEED_ADMIN_PASSWORD=', ''
    Write-Host " 初始管理员：admin / $adminPw"
    Write-Host ' ⚠️ 登录后请立即修改密码（改完不会再被重置）'
    Write-Host '──────────────────────────────────────────────────────────────'
}
Write-Host " 后台入口：   http://localhost:$webPort/"
Write-Host " 接口文档：   http://localhost:$webPort/api/v1/docs（需 SWAGGER_ENABLED=true）"
Write-Host ''
Write-Host ' 看日志：     docker compose --env-file deploy/.env logs -f api'
Write-Host ' 看状态：     docker compose --env-file deploy/.env ps'
Write-Host ' 停止：       docker compose --env-file deploy/.env down'
Write-Host ' 停止并清库： docker compose --env-file deploy/.env down -v   # ⚠️ 会删掉数据卷'
Write-Host '──────────────────────────────────────────────────────────────'
