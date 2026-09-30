# WinForms fixture for UIA tests: prints its HWND, then runs until closed.
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = "LumenFixture"
$f.Width = 360; $f.Height = 260
$f.StartPosition = "Manual"; $f.Left = 80; $f.Top = 80
$count = 0
$label = New-Object System.Windows.Forms.Label
$label.Text = "Count: 0"; $label.Left = 10; $label.Top = 10; $label.Width = 200
$btn = New-Object System.Windows.Forms.Button
$btn.Text = "Increment"; $btn.Name = "incrementButton"; $btn.Left = 10; $btn.Top = 40
$btn.Add_Click({ $script:count++; $label.Text = "Count: $script:count" })
$box = New-Object System.Windows.Forms.TextBox
$box.Name = "nameBox"; $box.Left = 10; $box.Top = 80; $box.Width = 200
$pw = New-Object System.Windows.Forms.TextBox
$pw.Name = "secretBox"; $pw.Left = 10; $pw.Top = 110; $pw.Width = 200; $pw.UseSystemPasswordChar = $true; $pw.Text = "hunter2"
$chk = New-Object System.Windows.Forms.CheckBox
$chk.Text = "Remember"; $chk.Left = 10; $chk.Top = 140
$f.Controls.AddRange(@($label, $btn, $box, $pw, $chk))
$f.Add_Shown({ [Console]::Out.WriteLine($f.Handle.ToInt64()); [Console]::Out.Flush() })
[System.Windows.Forms.Application]::Run($f)
