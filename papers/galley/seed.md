What makes, actually really what makes, what is the blueprint, and a scientific publication of epic impact proportions. How are those extremely high impact papers, regardless of the topic, different from the papers that do not end up having similar impact. What is actually different when you remove all kinds of bias from the analysis.

Look at autonomio/poise for how it makes software engineering semi-autonomous. We want to now create a new solution autonomio/galley which is an editor experience which makes writing and publishing high impact academic work follow the same patterns.

I should be able to give in my ideas in writing or just speak it to the system, but we don't need to worry about speech to text now, just assume input is text, and then based on that text the system first off knows how to produce a high quality academic work out of it. Not just take the text and do something, but challenge it against the principles we discuss above, and then make changes, do it's own work to fill in the gaps like run autonomio/canary to do systematic review to find the right refs and arguments to support, ... we can build systematic review capabilities that we need into canary, so in galley we can focus on the actual paper production side. But the citation finding is just one example...so all you need is a rant, and as long as that rant has value, you end up with epic scientific paper with projected high impact potential.

so every paper gets its own autonomio/resolvent is it?

So we want to be able to have agents do also the whole review workflow, so agent make paper, other agent come and review and leave comments, and then if auto fix is own, theyu keep going until hit cap if need to or until resolved, and human have the provenance.

Also, note how the side chat works in autonomio/poise editor, it proposes changes that are very easy to find in the doc so you know what is changing and to what, so that is when the humans wants to be part of the review process, you can get proposals for changes but you are in charge.

Also for citations, you should have full auto option but you should also be able to choose from choise like "for this claim choose a, b, or c" etc. etc.

Also, as human you are able to make comments were you like, and then agents take over. So you can always assign something to humans, agents, or both. Humans being the users in that project, and agents being the built-in capabilities. And multi-family is very important. We have gpt, claude, gemini carbon all playing different roles in it.

Also, from poise the big learning is the atomic behaviors, so here too we want to think about creating the paper and getting it to pre-publication draft that is ready for submission, in terms of what are the atomic behaviors that fully capature the whole thing so human doesn't have to give anything except the text blurb to seed it.

but remember, very important, we don't want a prison where work can't go through because some , was in wrong place supposedly or something else. We don't want some machinery that makes it seem like great software, and forgets that it should be a factor for churning out thousands of papers with high impact potential. This should somehow be built into what we do. And not monstrous tests that take 30 minutes to run. We don't have reason to believe we build bad software, so we don't do allow that kind of sunken cost testing. Tests are always minimal clinical. The behaviors we have to build so that we build them in order so that we can build one, prove that it works, build next one, prove that it works, and so forth, so the chain of proven capability becomes longer and longer, until it captures the full thing.

There is already now autonomio/galley as the foundation ... start building on that foundation until you can go from idea to full paper, and the first paper is the paper that introduces galley itself. So the test is to be able to do that end to end without any manual intervention and have it truly pre-pub ready.
