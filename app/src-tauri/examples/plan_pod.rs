//! Dev check of the planner on a running video pod: one 180 s two-character story, streamed, timed.
//! `cargo run --release --example plan_pod -- <base-url .../v1> <token> [model] [target_s]`
use app_lib::stories::{planner, Character, Story};
use std::time::Instant;

fn character(id: &str, name: &str, desc: &str) -> Character {
    Character {
        id: id.into(), name: name.into(), description: desc.into(), source: "generated".into(),
        consent: true, adult: true, ref_ids: vec![format!("{id}-ref")], ref_paths: vec![], vault: false,
        created_at: String::new(), updated_at: String::new(),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 { eprintln!("usage: plan_pod <base-url> <token> [model] [target_s]"); std::process::exit(2); }
    let model = args.get(3).cloned().unwrap_or_else(|| "qwen3.8-27b-uncensored".into());
    let target_s: u32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(180);
    let cast = vec![
        character("mara", "Mara", "woman in her 30s, short black hair, green bomber jacket"),
        character("ivo", "Ivo", "man in his 40s, grey beard, dark wool coat"),
    ];
    let story = Story {
        id: "probe".into(), title: String::new(), logline: String::new(),
        brief: "A reunion at a train station: Mara steps off a train and finds Ivo waiting on the platform after ten years apart; \
                they talk awkwardly about what happened, walk out into the rain together, and end up laughing under one umbrella. \
                Include spoken dialogue.".into(),
        target_s, aspect: "16:9".into(), style: "35 mm film, warm grain".into(), cast: vec!["mara".into(), "ivo".into()],
        voices: vec![], status: "draft".into(), result_image_id: None, vault: false, created_at: String::new(), updated_at: String::new(),
    };
    let t = Instant::now();
    let first = std::sync::Mutex::new(None::<f64>);
    let last = std::sync::Mutex::new((0u32, 0u32));
    let out = planner::plan_with_progress(&args[1], &model, Some(&args[2]), &story, &cast, &|p| {
        if p.phase == "writing" && p.tokens > 0 { first.lock().unwrap().get_or_insert(t.elapsed().as_secs_f64()); }
        let mut l = last.lock().unwrap();
        if p.attempt != l.0 || p.tokens >= l.1 + 1000 { eprintln!("  attempt {} {} {} tokens @ {:.1}s", p.attempt, p.phase, p.tokens, t.elapsed().as_secs_f64()); *l = (p.attempt, p.tokens); }
    }).await;
    let total = t.elapsed().as_secs_f64();
    let ttft = first.lock().unwrap().unwrap_or(0.0);
    match out {
        Ok(o) => {
            let secs: u32 = o.shots.iter().map(|s| s.duration_s).sum();
            let words: usize = o.shots.iter().map(|s| s.action.split_whitespace().count()).sum();
            println!("OK attempts={} shots={} film={}s (target {}) issues={} total={:.1}s first_token={:.1}s avg_action_words={}",
                o.attempts, o.shots.len(), secs, target_s, o.issues.len(), total, ttft, words / o.shots.len().max(1));
            for i in &o.issues { println!("  issue: shot {:?}: {}", i.shot, i.message); }
            if let Some(s) = o.shots.first() { println!("shot 1 action: {}", s.action); }
        }
        Err(e) => println!("ERR after {total:.1}s: {e}"),
    }
}
