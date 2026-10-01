# WinForms fixture for the conformance suite. Prints its HWND, then runs until closed.
param([int]$Left = 80, [int]$Top = 80)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = "LumenFixture"
$f.Width = 420; $f.Height = 360
$f.StartPosition = "Manual"; $f.Left = $Left; $f.Top = $Top
$f.TopMost = $true
$font = New-Object System.Drawing.Font("Segoe UI", 14)

$count = 0
$label = New-Object System.Windows.Forms.Label
$label.Text = "Count: 0"; $label.Name = "countLabel"; $label.Left = 10; $label.Top = 10; $label.Width = 260; $label.Height = 34
$label.Font = $font
$btn = New-Object System.Windows.Forms.Button
$btn.Text = "Increment"; $btn.Name = "incrementButton"; $btn.Left = 10; $btn.Top = 50; $btn.Width = 140; $btn.Height = 34
$btn.Add_Click({ $script:count++; $label.Text = "Count: $script:count" })
$box = New-Object System.Windows.Forms.TextBox
$box.Name = "nameBox"; $box.Left = 10; $box.Top = 95; $box.Width = 260
$pw = New-Object System.Windows.Forms.TextBox
$pw.Name = "secretBox"; $pw.Left = 10; $pw.Top = 125; $pw.Width = 260; $pw.UseSystemPasswordChar = $true; $pw.Text = "hunter2"
$chk = New-Object System.Windows.Forms.CheckBox
$chk.Text = "Remember"; $chk.Name = "rememberBox"; $chk.Left = 10; $chk.Top = 155; $chk.Width = 140
$combo = New-Object System.Windows.Forms.ComboBox
$combo.Name = "colorCombo"; $combo.Left = 10; $combo.Top = 185; $combo.Width = 140
$combo.DropDownStyle = "DropDownList"
[void]$combo.Items.AddRange(@("Red", "Green", "Blue"))
$list = New-Object System.Windows.Forms.ListBox
$list.Name = "fruitList"; $list.Left = 170; $list.Top = 185; $list.Width = 120; $list.Height = 70
[void]$list.Items.AddRange(@("Apple", "Banana", "Cherry"))

$f.Controls.AddRange(@($label, $btn, $box, $pw, $chk, $combo, $list))
$f.Add_Shown({ $f.Activate(); [Console]::Out.WriteLine($f.Handle.ToInt64()); [Console]::Out.Flush() })
[System.Windows.Forms.Application]::Run($f)
