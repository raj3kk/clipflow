package com.clipflow.agent.apps

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import com.clipflow.agent.data.DeviceStore
import org.json.JSONArray
import org.json.JSONObject

/** Ek installed launchable app. */
data class InstalledApp(val pkg: String, val label: String)

/** Ek user-imported app (persisted selection). */
data class ImportedApp(val pkg: String, val label: String)

/**
 * App import (2026-09-22 rebuild).
 *
 * User apne installed apps me se chun sakta hai kaunsi apps automation
 * ke liye "imported" hain — searchable multi-select dialog, icons ke saath.
 * Selection DeviceStore me JSON banke rehti hai (server pe apps ka koi
 * route nahi hai, isliye sync local hai; automation DeviceStore se padhti hai).
 *
 * Android 11+ pe installed-apps visibility ke liye manifest me <queries>
 * (launcher intent) zaroori hai — nahi to list khaali aayegi.
 */
object AppImporter {

    /** Launcher se khulne wali saari user apps (system apps bahar). */
    @JvmStatic
    fun queryInstalledApps(ctx: Context): List<InstalledApp> {
        return try {
            val pm = ctx.packageManager
            val main = Intent(Intent.ACTION_MAIN, null).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
            val infos = try {
                pm.queryIntentActivities(main, 0)
            } catch (_: Exception) {
                emptyList()
            }
            infos.mapNotNull { ri ->
                try {
                    val pkg = ri.activityInfo?.packageName ?: return@mapNotNull null
                    // khud ki app list me nahi
                    if (pkg == ctx.packageName) return@mapNotNull null
                    val label = try {
                        ri.loadLabel(pm)?.toString()?.take(48)
                    } catch (_: Exception) {
                        null
                    } ?: pkg
                    InstalledApp(pkg, label)
                } catch (_: Exception) {
                    null
                }
            }.sortedBy { it.label.lowercase() }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** Searchable multi-select dialog kholo. Save pe store me persist. */
    @JvmStatic
    fun showPicker(activity: Activity, store: DeviceStore, onSaved: () -> Unit = {}) {
        val apps = queryInstalledApps(activity)
        if (apps.isEmpty()) {
            android.widget.Toast.makeText(
                activity, "Koi app nahi mili (Android 11+ pe dobara try karo)",
                android.widget.Toast.LENGTH_LONG
            ).show()
            return
        }
        val selected = importedApps(store).map { it.pkg }.toMutableSet()
        val dens = activity.resources.displayMetrics.density

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (16 * dens).toInt()
            setPadding(pad, pad, pad, 0)
        }
        val search = EditText(activity).apply {
            hint = "🔍 App dhoondho…"
            setSingleLine(true)
            val pad = (12 * dens).toInt()
            setPadding(pad, pad, pad, pad)
        }
        root.addView(search, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = (8 * dens).toInt() })

        val listView = ListView(activity).apply { id = View.generateViewId() }
        root.addView(listView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
        ))

        val pm = activity.packageManager
        val iconCache = mutableMapOf<String, Drawable?>()
        fun iconFor(pkg: String): Drawable? = iconCache.getOrPut(pkg) {
            try { pm.getApplicationInfo(pkg, 0).loadIcon(pm) } catch (_: Exception) { null }
        }

        val adapter = object : ArrayAdapter<InstalledApp>(
            activity, android.R.layout.simple_list_item_1, apps.toMutableList()
        ), android.widget.Filterable {
            private var filtered: List<InstalledApp> = apps
            private val lock = Any()

            override fun getCount(): Int = synchronized(lock) { filtered.size }
            override fun getItem(position: Int): InstalledApp =
                synchronized(lock) { filtered[position] }

            override fun getView(pos: Int, cv: View?, parent: ViewGroup): View {
                val app = getItem(pos)
                val row = (cv as? LinearLayout) ?: LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    val p = (10 * dens).toInt()
                    setPadding(p, p, p, p)
                }
                row.removeAllViews()
                val iconSize = (40 * dens).toInt()
                val iv = ImageView(context).apply {
                    layoutParams = LinearLayout.LayoutParams(iconSize, iconSize).apply {
                        marginEnd = (12 * dens).toInt()
                    }
                    setImageDrawable(iconFor(app.pkg))
                }
                val tv = TextView(context).apply {
                    text = app.label
                    textSize = 16f
                    setTextColor(Color.parseColor("#111827"))
                    layoutParams = LinearLayout.LayoutParams(0,
                        LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                }
                val cb = CheckBox(context).apply {
                    isChecked = selected.contains(app.pkg)
                    isFocusable = false
                    isClickable = false
                }
                row.addView(iv); row.addView(tv); row.addView(cb)
                row.setOnClickListener {
                    if (selected.contains(app.pkg)) selected.remove(app.pkg)
                    else selected.add(app.pkg)
                    cb.isChecked = selected.contains(app.pkg)
                }
                row.tag = app.pkg
                return row
            }

            override fun getFilter(): android.widget.Filter {
                return object : android.widget.Filter() {
                    override fun performFiltering(c: CharSequence?): android.widget.Filter.FilterResults {
                        val q = c?.toString()?.trim()?.lowercase().orEmpty()
                        val res = if (q.isEmpty()) apps
                        else apps.filter {
                            it.label.lowercase().contains(q) || it.pkg.lowercase().contains(q)
                        }
                        return android.widget.Filter.FilterResults().apply {
                            values = res; count = res.size
                        }
                    }
                    @Suppress("UNCHECKED_CAST")
                    override fun publishResults(c: CharSequence?, r: android.widget.Filter.FilterResults?) {
                        synchronized(lock) {
                            filtered = (r?.values as? List<InstalledApp>) ?: apps
                        }
                        notifyDataSetChanged()
                    }
                }
            }
        }
        listView.adapter = adapter
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {
                adapter.filter.filter(s)
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        AlertDialog.Builder(activity)
            .setTitle("📱 Apps import karo (${apps.size})")
            .setView(root)
            .setPositiveButton("Save") { _, _ ->
                try {
                    val arr = JSONArray()
                    for (pkg in selected) {
                        val app = apps.firstOrNull { it.pkg == pkg } ?: continue
                        arr.put(JSONObject().put("package", app.pkg).put("label", app.label))
                    }
                    store.saveImportedAppsJson(arr.toString())
                    android.widget.Toast.makeText(
                        activity, "${selected.size} apps imported ✅",
                        android.widget.Toast.LENGTH_SHORT
                    ).show()
                } catch (_: Exception) {
                }
                try { onSaved() } catch (_: Exception) { }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /** Persisted selection padho. */
    @JvmStatic
    fun importedApps(store: DeviceStore): List<ImportedApp> {
        return try {
            val raw = store.importedAppsJson() ?: return emptyList()
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val pkg = o.optString("package", "")
                if (pkg.isEmpty()) null
                else ImportedApp(pkg, o.optString("label", pkg))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** Kya ye package imported hai? (automation gate ke liye) */
    @JvmStatic
    fun isImported(store: DeviceStore, pkg: String): Boolean {
        return try {
            importedApps(store).any { it.pkg == pkg }
        } catch (_: Exception) {
            false
        }
    }
}
