//! Dev check of local planner quality: five 60 s briefs, two characters, real planner code.
//! `cargo run --release --example plan_check -- <model-id> <base-url> [out.json]`
use app_lib::stories::{compile, planner, Character, Story};
use serde_json::{json, Value};
use std::time::Instant;

fn character(id: &str, name: &str, desc: &str, refs: &[&str]) -> Character {
    Character {
        id: id.into(), name: name.into(), description: desc.into(), source: "generated".into(),
        consent: true, adult: true, ref_ids: refs.iter().map(|s| s.to_string()).collect(), ref_paths: vec![],
        created_at: String::new(), updated_at: String::new(),
    }
}

const BRIEFS: [(&str, &str); 5] = [
    ("heist", "A heist on a rooftop at night: Mara and Ivo crack a skylight to reach a vault below, argue in whispers about the plan, and a searchlight sweeps over them. Include spoken dialogue between them."),
    ("breakup", "A quiet breakup in a late-night diner: Mara and Ivo sit across a booth, coffee going cold, and calmly admit it is over. Include spoken dialogue, with long silences."),
    ("chase", "A chase through a crowded night market: Ivo runs after Mara, who has grabbed his bag; they shout at each other as they weave between stalls, ending in a standoff. Include spoken dialogue."),
    ("reunion", "A reunion at a train station: Mara steps off a train and finds Ivo waiting on the platform after ten years apart; they talk awkwardly, then embrace. Include spoken dialogue."),
    ("cooking", "A comedic cooking disaster: Mara and Ivo try to cook dinner for guests, a pan catches fire, they panic and bicker, and they end up laughing in the smoke. Include spoken dialogue."),
];

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 { eprintln!("usage: plan_check <model-id> <base-url> [out.json]"); std::process::exit(2); }
    let (model, base) = (&args[1], &args[2]);
    let cast = vec![
        character("mara", "Mara", "woman in her 30s, short black hair, green bomber jacket", &["m1", "m2"]),
        character("ivo", "Ivo", "man in his 40s, grey beard, dark wool coat", &["i1"]),
    ];
    let mut results = Vec::new();
    let mut rows = Vec::new();
    for (name, brief) in BRIEFS {
        let story = Story {
            id: format!("s-{name}"), title: String::new(), logline: String::new(), brief: brief.into(), target_s: 60,
            aspect: "16:9".into(), style: String::new(), cast: vec!["mara".into(), "ivo".into()], voices: vec![],
            status: "draft".into(), result_image_id: None, created_at: String::new(), updated_at: String::new(),
        };
        eprintln!("planning {name} ...");
        let t = Instant::now();
        let res = planner::plan(base, model, &story, &cast).await;
        let secs = t.elapsed().as_secs_f64();
        match res {
            Ok(o) => {
                let total: u32 = o.shots.iter().map(|s| s.duration_s).sum();
                let n = o.shots.len();
                let pass = o.issues.is_empty() && (4..=10).contains(&n);
                let planned = Story { voices: o.voices.clone(), title: o.title.clone(), logline: o.logline.clone(), ..story.clone() };
                let mut compiled = Vec::new();
                if let Some(s) = o.shots.first() {
                    compiled.push(json!({"shot": 1, "first_frame": false, "result": compile::compile_shot(&planned, s, &cast, false).map(|c| c.prompt)}));
                }
                if let Some((i, s)) = o.shots.iter().enumerate().find(|(_, s)| s.continuity == "continues") {
                    compiled.push(json!({"shot": i + 1, "first_frame": true, "result": compile::compile_shot(&planned, s, &cast, true).map(|c| c.prompt)}));
                }
                let issues: Vec<String> = o.issues.iter().map(|i| match i.shot { Some(n) => format!("Shot {n}: {}", i.message), None => i.message.clone() }).collect();
                rows.push((name.to_string(), secs, o.attempts, n, total, pass, issues.len()));
                results.push(json!({"brief": name, "seconds": secs, "attempts": o.attempts, "shots": n, "total_s": total, "pass": pass,
                    "title": o.title, "logline": o.logline, "issues": issues,
                    "voices": o.voices.iter().map(|v| json!({"character_id": v.character_id, "voice": v.voice})).collect::<Vec<_>>(),
                    "plan": o.shots, "compiled": compiled}));
            }
            Err(e) => {
                rows.push((name.to_string(), secs, 0, 0, 0, false, 1));
                results.push(json!({"brief": name, "seconds": secs, "error": e, "pass": false}));
            }
        }
    }
    println!("{:<10} {:>7} {:>4} {:>5} {:>6} {:>5} {:>6}", "brief", "secs", "att", "shots", "total", "pass", "issues");
    for (n, s, a, k, t, p, i) in &rows { println!("{n:<10} {s:>7.1} {a:>4} {k:>5} {t:>6} {:>5} {i:>6}", if *p { "PASS" } else { "FAIL" }); }
    println!("passed {}/{}", rows.iter().filter(|r| r.5).count(), rows.len());
    if let Some(path) = args.get(3) {
        let doc: Value = json!({"model": model, "results": results});
        std::fs::write(path, serde_json::to_string_pretty(&doc).unwrap()).expect("write results");
        println!("wrote {path}");
    }
}
